// One rebuild per burst of watcher events, and never two at once.
//
// Two things went wrong without this. A single token edit under Vite's dev
// server reached both the `configureServer` listener and `watchChange` —
// Vite 6, 7 and 8 all invoke plugin `watchChange` while serving — and each
// started its own build, so one write produced two. And nothing serialised
// them: a four-file change started one build per file, all overlapping.
// `runBuilds` builds its configurations one after another precisely so two
// instances never write the same destination at once, and concurrent calls
// to it reintroduced that one level up.
//
// The trailing debounce collapses the burst; the in-flight chain means a
// trigger arriving mid-build queues exactly one follow-up rather than
// starting a second build beside it.
//
// **Every plugin instance gets a scheduler of its own**, so the state below
// lives inside `createScheduler` rather than at module scope. One process
// routinely holds several instances, and a debounce they shared would collapse
// two instances' triggers into one rebuild — run by only one of them, with the
// other's output left stale and its caller told it was covered.

import { asError } from './errors.js'

// Returns `schedule`, which resolves once a rebuild covering its trigger has
// finished, and rejects with what that rebuild threw.
//
// `run` is the rebuild itself, and a failure is whatever it throws. `isClosed`
// is asked on every trigger, because the host closes its watcher after the
// scheduler exists.
export function createScheduler({
  debounceMs,
  isClosed,
  run,
}: {
  debounceMs: number
  isClosed: () => boolean
  run: (reason: string) => Promise<void>
}): (reason: string) => Promise<void> {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let pendingReason: string | undefined
  let inFlight: Promise<void> | undefined
  let waiting: Array<(failure?: { error: unknown }) => void> = []

  const drain = async (): Promise<void> => {
    // A loop rather than a single pass: anything scheduled while the build
    // below is running is picked up here instead of starting a second one.
    while (pendingReason !== undefined) {
      const reason = pendingReason
      pendingReason = undefined

      // Captured before the await, so a trigger arriving mid-build waits for
      // the next pass rather than being told this one covered it.
      const resolvers = waiting
      waiting = []

      let failure: undefined | { error: unknown }

      try {
        await run(reason)
      } catch (err) {
        failure = { error: err }
      }

      // Handed on to whatever awaited this rebuild, which is `watchChange`
      // and so the host under a watching bundler. Vite's dev-server listener
      // has no build to fail and catches it.
      for (const settle of resolvers) settle(failure)
    }
  }

  // Resolves once a rebuild covering this trigger has finished.
  return async (reason: string): Promise<void> => {
    // Nothing consumes a rebuild once the host has closed its watcher. This is
    // where a close actually lands: `watchChange` reaches here only after
    // resolving configurations and deriving a watch list, so a `closeWatcher`
    // arriving mid-hook finds no timer armed yet and nothing else to stop it.
    //
    // Resolving rather than rejecting, because the trigger was handled — by
    // being declined — and the caller awaiting it is a host on its way out.
    if (isClosed()) return

    pendingReason = reason

    const covered = new Promise<void>((resolve, reject) => {
      waiting.push((failure) => {
        if (failure) reject(asError(failure.error))
        else resolve()
      })
    })

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      inFlight = (inFlight ?? Promise.resolve()).then(drain)
    }, debounceMs)

    // A pending rebuild must not be what keeps a process alive; whatever is
    // watching already is.
    debounceTimer.unref()

    return covered
  }
}
