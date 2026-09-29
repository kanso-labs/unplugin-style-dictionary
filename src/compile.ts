// One compile of every resolved configuration: building each one through the
// atomic volume, recording what it wrote, and saying how it went.
//
// Nothing here holds state. What a plugin instance owns is handed in as a
// `PluginInstance`, which the factory builds once, and the two parts of it
// that are assigned after the factory has run — `root` and the overlay
// callback — are reached through it when a compile runs rather than copied
// when it was built.

import fs from 'node:fs'
import path from 'node:path'
import StyleDictionary from 'style-dictionary'

import type { ResolvedConfig } from './config.js'
import type { UnpluginStyleDictionaryOptions } from './types.js'
import type { DestinationRecord } from './up-to-date.js'

import { configForBuild, describeConfig, readConfigObject } from './config.js'
import { asError, errorMessage } from './errors.js'
import { patternsMatchingNothing, sourcePatternsOf } from './patterns.js'
import { reportSizes } from './size-report.js'
import {
  configFingerprint,
  declaredDestinations,
  isUpToDate,
  newestSourceOf,
  readPersistedRecords,
  recordOf,
  recordsFileFor,
  writePersistedRecords,
  writtenDestination,
} from './up-to-date.js'

// What `runBuilds` reads from the plugin instance it compiles for.
//
// `root` and `notifyBuildOutcome` are functions for the same reason: each is
// assigned after the factory has run — `root` by `adoptCompiler` or
// `configResolved`, the overlay callback by `configureServer` — so a value
// copied when this was built would be the working directory and `undefined`
// for good. `generatedDestinations` is the instance's own record of what it
// wrote, and `destinationRecords` is the process's record of which
// configuration last wrote each file and what it read, with
// `persistedRecordFiles` naming the file each root's copy persists to;
// none of them lives here.
export interface PluginInstance {
  cache: boolean
  destinationRecords: Map<string, DestinationRecord>
  failOnError: NonNullable<UnpluginStyleDictionaryOptions['failOnError']>
  generatedDestinations: Set<string>
  log: (message: string, type: 'error' | 'info' | 'success') => void
  notifyBuildOutcome: (error: Error | null) => void
  onBuildEnd: UnpluginStyleDictionaryOptions['onBuildEnd']
  onBuildError: UnpluginStyleDictionaryOptions['onBuildError']
  onBuildStart: UnpluginStyleDictionaryOptions['onBuildStart']
  persistedRecordFiles: Map<string, string>
  platformsOption: UnpluginStyleDictionaryOptions['platforms']
  quiet: boolean
  report: boolean
  root: () => string
  stdoutColour: boolean
  verbosity: 'default' | 'silent' | 'verbose' | undefined
  volume: typeof fs
  watch: UnpluginStyleDictionaryOptions['watch']
}

// Compile design tokens
export async function runBuilds(
  instance: PluginInstance,
  resolvedConfigs: ResolvedConfig[],
  context?: string,
): Promise<void> {
  const {
    cache,
    destinationRecords,
    failOnError,
    generatedDestinations,
    log,
    notifyBuildOutcome,
    onBuildEnd,
    onBuildError,
    onBuildStart,
    persistedRecordFiles,
    platformsOption,
    quiet,
    report,
    stdoutColour,
    verbosity,
    volume,
    watch,
  } = instance

  // Read when this compile starts rather than when the instance was built,
  // because the host assigns it after the factory has run.
  const root = instance.root()

  const startTime = Date.now()

  // Ahead of the `try` rather than inside it, because the reporting below
  // reads it and that reporting is deliberately outside.
  const generatedFiles = new Set<string>()

  // How many configurations were already up to date. Read by the reporting
  // below, which is why it sits out here with `generatedFiles`.
  let skipped = 0

  // The records an earlier process persisted for this root, loaded the first
  // time this process compiles for it and never over a record this process
  // wrote itself. Only with `cache` on, the one case that reads or keeps
  // them: every other build compiles regardless.
  let recordsFile = cache ? persistedRecordFiles.get(root) : undefined
  if (cache && recordsFile === undefined) {
    recordsFile = recordsFileFor(root)
    persistedRecordFiles.set(root, recordsFile)
    for (const [destination, record] of readPersistedRecords(recordsFile)) {
      if (!destinationRecords.has(destination)) {
        destinationRecords.set(destination, record)
      }
    }
  }

  // What this compile recorded, and so what it adds to the persisted copy.
  const recorded = new Map<string, DestinationRecord>()

  try {
    if (!context) {
      log('Compiling design tokens...', 'info')
    }

    // Before anything is resolved or built, and once per build — a watch
    // rebuild is a build, so this fires again for each one.
    if (onBuildStart) callHook(log, 'onBuildStart', onBuildStart)

    // Configurations are built one after another rather than with
    // `Promise.all`, and that is load-bearing. Two configurations may name
    // the same destination file, and each instance gets the atomic volume
    // swapped onto it below — overlapping builds would interleave those
    // writes and hand a reader a file assembled from both.
    for (const [index, item] of resolvedConfigs.entries()) {
      // Read ahead of the instance, because avoiding the instance is the
      // point: construction plus `extend` is the 15-30% of a build that
      // parses the token sources, and `buildAllPlatforms` is the rest.
      //
      // Without a `report`, so a configuration that will not parse says
      // nothing here — the build below hands Style Dictionary the path and
      // lets its own message through, which is more specific than anything
      // this could say.
      const declared = cache ? await readConfigObject(item) : null
      const selectedPlatforms = platformsFor(platformsOption, context)

      // Ahead of the up-to-date check, which judges a selection by the
      // destinations the configuration declares for it and so cannot see a
      // name it does not define: `['css', 'andriod']` was judged on `css`
      // alone, and with `css` current the whole build was skipped and the typo
      // went unreported until a source changed. The build path checks again
      // below, for the builds that reach it without `declared`.
      if (declared) {
        checkSelection(item, index, selectedPlatforms, declared.platforms)
      }

      // What this configuration reads, as it stands before the compile below
      // reads any of it. The up-to-date check needs it now, and the record
      // needs it afterwards: it is what the next check measures "changed
      // since" against. Only asked with `cache` on, the one case that reads it.
      const newestSource = declared
        ? await newestSourceOf({ log, root, watch }, item, declared)
        : null

      // Who this configuration is: its contents, the hooks it names as the
      // registry holds them now, and the Style Dictionary version. Taken here,
      // after the `config` function's `register*` calls have landed, and once:
      // the check compares it with each destination's record, and the record
      // keeps it. Only with `cache` on, because nothing compares it otherwise
      // and reading a configuration module to compute it would run it again.
      const fingerprint = declared
        ? configFingerprint(root, item, declared)
        : null

      if (
        declared &&
        isUpToDate(
          { destinationRecords, fingerprint, newestSource },
          item,
          declared,
          selectedPlatforms,
        )
      ) {
        // The destinations still have to be collected. They are what stops
        // the plugin's own output being treated as a watched source, so a
        // skipped configuration that contributed none would have its files
        // rebuild the moment a watcher noticed them.
        for (const destination of declaredDestinations(declared)) {
          generatedFiles.add(destination)
        }

        skipped++
        continue
      }

      // `{ init: false }` is the escape hatch Style Dictionary documents on
      // this constructor, and it is what makes a bad configuration
      // catchable. Left to itself the constructor ends in a call to
      // `init()` whose promise it neither stores nor returns, so a config
      // that fails to load rejects a promise nobody holds: the `catch`
      // below never runs, and the host dies with a raw stack or — where an
      // `unhandledRejection` handler suppresses it — hangs on a
      // `buildStart` that never settles. `await sd.hasInitialized` cannot
      // observe it either, since that promise is only ever resolved, at the
      // tail of a successful extend.
      //
      // It is handed the configuration as an object rather than as a path
      // for the same reason: Style Dictionary imports a path with no
      // cache-busting query of its own, so under a long-lived dev server
      // every rebuild after the first built the config the process started
      // with while the watch list followed the edit.
      const sd = new StyleDictionary(await configForBuild(item), {
        init: false,
      })

      // One initialisation rather than two. `init()` is `extend()` with
      // `mutateOriginal`, so the old pair loaded the configuration and
      // combined every source twice — running a custom parser or
      // preprocessor twice with it — and the first of the two ran at
      // default verbosity, which is how Style Dictionary's own warnings
      // escaped this plugin's `silent`. `config` defaults to the one the
      // constructor was handed.
      //
      // `verbosity` is `undefined` unless a consumer asked for a level, and
      // Style Dictionary falls through an unset one to the configuration's
      // own `log.verbosity`. Overwriting it here is what silenced the one
      // line explaining why a build wrote nothing. `log.warnings` is not
      // touched either way: a consumer's `warnings: 'error'` turning a
      // missing output file into a thrown build is their decision.
      await sd.extend(undefined, { mutateOriginal: true, verbosity })

      // **Before the build, and that is the whole of it.** A token set that
      // resolved to nothing is not an error anywhere in this stack: Style
      // Dictionary writes the file with no custom properties in it, prints
      // its usual `✔︎` line at any verbosity, and returns. So a token file
      // deleted mid-session took the generated output down with it and
      // reported `Rebuilt design tokens` while doing it, and a `source`
      // matching nothing shipped an empty stylesheet from a build that
      // exited 0.
      //
      // Checked here because `buildAllPlatforms` truncates and rewrites the
      // destination: one line later the previous good output is already gone
      // and an error would be accurate and useless.
      if (sd.allTokens.length === 0) {
        // The configuration as an object, so its own patterns can be named.
        // Without a `report`, because a configuration that will not parse
        // never reaches here — the `extend` above would have thrown first.
        const asObject = await readConfigObject(item)
        const barren = asObject
          ? await patternsMatchingNothing(sourcePatternsOf(asObject))
          : []

        // Thrown rather than reported, so it takes the path `failOnError`
        // already owns — the same decision, made in one place, rather than a
        // second way for a build to fail.
        throw new Error(
          [
            `${describeConfig(item, index)} resolved no tokens, so its output would be emptied.`,
            barren.length > 0
              ? `These patterns matched no files: ${barren.join(', ')}`
              : `It declares no source or include patterns that matched anything.`,
            `Nothing was written. Set failOnError to false to build anyway.`,
          ].join(' '),
        )
      }

      // Swap in the atomic volume only now that the instance has finished
      // reading its configs and token sources, so every write below lands
      // through `rename` while the read path stays exactly as it was. Seen
      // through a layer that notes what this build writes, which the record
      // below needs: a declared file is not necessarily a written one.
      const wrote = new Set<string>()
      sd.volume = notingWrites(volume, wrote)

      // The files this compile is about to write, named exactly as the
      // up-to-date check names them, and only the selected platforms' — a
      // scoped build leaves the others' files, and whatever wrote them, alone.
      const writing = declaredDestinations(
        { platforms: sd.platforms },
        selectedPlatforms,
      )

      // Forgotten before the first write rather than overwritten after the
      // last, because a build that throws partway has already replaced some
      // of these files. A record left standing would vouch for output that
      // no longer matches the configuration it names.
      for (const destination of writing) {
        destinationRecords.delete(destination)
      }

      if (selectedPlatforms === undefined) {
        await sd.buildAllPlatforms()
      } else {
        // `cache: false`, and a configuration that would not parse ahead of
        // `extend`, arrive here without the check above having run.
        checkSelection(item, index, selectedPlatforms, sd.platforms)

        // One after another, matching the loop this sits inside: two
        // platforms may name the same destination, and `buildAllPlatforms`
        // fanning its own out with `Promise.all` is Style Dictionary's
        // choice over configurations it owns, not this plugin's over a
        // selection a consumer wrote.
        for (const name of selectedPlatforms) {
          await sd.buildPlatform(name)
        }
      }

      // Every declared platform, not only the ones this compile built. A
      // file an unselected platform wrote on an earlier build is still the
      // plugin's own output, and dropping it from this set would let a
      // watcher treat it as a token source and rebuild on it forever.
      //
      // Collected on every build rather than only on the ones whose size
      // report prints it below. The set is also what keeps a rebuild from
      // being triggered by the write it just made, and a rebuild passes a
      // `context` — so gating the collection on `!context` left it empty on
      // exactly the builds a watcher is live for.
      //
      // Named by `writtenDestination`, the one place that knows where Style
      // Dictionary writes a file. Every copy of that rule this code has had
      // named files that were never written — against `root` until #362, and
      // an absolute destination until #367 — and handed them to `onBuildEnd`,
      // the size report and this very set.
      for (const platform of Object.values(sd.platforms)) {
        for (const file of platform.files ?? []) {
          if (file.destination) {
            generatedFiles.add(
              writtenDestination(platform.buildPath, file.destination),
            )
          }
        }
      }

      // Recorded only now, so a build that threw vouches for none of what it
      // wrote before throwing. Every configuration is recorded, a file-backed
      // one included: an object configuration naming the same file has to
      // see that something else wrote it last.
      //
      // `newestSource` goes in beside the fingerprint. It was taken before
      // this compile read anything, so a source saved while it ran is newer
      // than it, and the rebuild queued for that save is not skipped. So does
      // each file's mtime as this compile left it, byte-identical skip and
      // all: a later check trusts the record only while the file still has
      // it. A file Style Dictionary declined to write is recorded as such, so
      // a later check does not go looking for it; one it wrote and that is
      // already gone gets no record, so the next build compiles.
      //
      // Only a compile with `cache` on has a fingerprint to record. One with it
      // off has still forgotten what it rewrote, above, which is what keeps
      // every other instance from vouching for its output.
      if (fingerprint !== null) {
        for (const destination of writing) {
          const record = recordOf(
            destination,
            fingerprint,
            newestSource,
            wrote.has(destination),
          )
          if (record) {
            destinationRecords.set(destination, record)
            recorded.set(destination, record)
          }
        }
      }
    }

    // Replaced wholesale rather than added to, so a destination dropped from
    // a configuration stops being treated as ours and becomes watchable
    // again. A build that throws never reaches this and leaves the previous
    // set standing, which is the safe direction: the files it wrote before
    // failing are still ours.
    // Once per compile rather than per configuration, and only after every
    // configuration succeeded. A compile that throws persists nothing, which
    // is safe: whatever it rewrote no longer has the mtime its old record
    // names, so that record vouches for nothing.
    if (recordsFile !== undefined && recorded.size > 0) {
      writePersistedRecords(recordsFile, recorded)
    }

    generatedDestinations.clear()
    for (const destination of generatedFiles) {
      generatedDestinations.add(destination.replace(/\\/g, '/'))
    }
  } catch (err) {
    const duration = Date.now() - startTime
    log(`Compilation failed after ${duration}ms: ${errorMessage(err)}`, 'error')

    // Ahead of the throw decision on purpose, so the overlay sees a failure
    // whatever `failOnError` does with it. Under the dev server's default
    // the line below does not throw, and reading the outcome from a caller's
    // `catch` would see a rebuild that looked like it succeeded.
    notifyBuildOutcome(asError(err))

    // Ahead of the throw decision for the same reason as the line above: a
    // rebuild under the dev server's default does not throw, and a hook that
    // only fired when something else was about to fail would be silent on
    // exactly the builds a consumer is watching.
    if (onBuildError) callHook(log, 'onBuildError', onBuildError, err)

    // Reported, and then rethrown so the host stops. Swallowing it left
    // every target exiting 0 with the previous run's tokens still on disk
    // and in the bundle — a green build shipping stale values.
    if (failsTheBuild(failOnError, context)) throw err

    // Explicit, now that the reporting below sits outside the `try`. This
    // `catch` used to end the function by falling off the end of it; a
    // failure that is not rethrown would otherwise carry on to announce a
    // compile that did not happen.
    return
  }

  // The compile is what the overlay reflects, so this is said here rather
  // than at the end: everything below is reporting, it returns early in
  // three places, and a size table that throws must not leave a successful
  // build looking unfinished.
  notifyBuildOutcome(null)

  // One measurement, read by the hook below and by the reporting under it.
  const duration = Date.now() - startTime

  // Beside the overlay notification, and for the same reason it sits here
  // rather than at the end of the function: the reporting below returns
  // early in three places, and a build that finished has finished whether or
  // not a size table gets printed for it.
  //
  // Sorted, so two runs of one configuration hand back the same order —
  // `generatedFiles` is a set in platform-then-file order, which is stable
  // in practice and guaranteed by nothing. The paths stay platform-native:
  // this is a list a consumer is going to open files with, not one the
  // watcher compares against.
  //
  // Only the declared files that are on disk. One whose filter matched no
  // tokens is declared and never written, and a hook opening it got an ENOENT.
  if (onBuildEnd) {
    // `toSorted` is what the linter asks for and what this cannot use:
    // `lib` is ES2022 here and `toSorted` is ES2023, so it types as an error
    // even though every Node this package supports has it. The rule guards
    // against mutating an array someone else holds, and this one was built
    // from the set on the line it appears on.
    const files = Array.from(generatedFiles)
      .filter((file) => fs.existsSync(file))
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((left, right) => left.localeCompare(right))
    callHook(log, 'onBuildEnd', onBuildEnd, files, duration)
  }

  // The `try` ends above, and everything from here down is reporting. Style
  // Dictionary has finished writing by now and `generatedDestinations` is
  // already replaced, so nothing below can put a file on disk in doubt —
  // which is why a throw from it must not be caught as a compile failure.
  // It used to be: a fault in the padding arithmetic printed `Compilation
  // failed after 19ms` over a build whose every token file was correct, and
  // with `failOnError` defaulting to `'build'` that stopped the bundler.

  // Every configuration was already current, so nothing was written. Said
  // rather than left implied: a build that prints its opening line and then
  // finishes in two milliseconds reads as one that silently did nothing.
  const everythingSkipped = skipped === resolvedConfigs.length

  if (context) {
    log(
      everythingSkipped
        ? `Design tokens already up to date after change in ${context} (${duration}ms)`
        : `Rebuilt design tokens due to change in ${context} (${duration}ms)`,
      'success',
    )
    return
  }

  // The table is skipped when nothing was written, on top of `report` and
  // `quiet`. It reads every generated file in full and gzips it, and
  // reprinting the sizes of files this build did not touch is the one case
  // where that cost buys nothing at all.
  if (report && !quiet && !everythingSkipped && generatedFiles.size > 0) {
    try {
      reportSizes({ root, stdoutColour }, generatedFiles)
    } catch (err) {
      // At `'error'`, so it is said at every level including `silent`,
      // exactly as a compile failure is — and worded so it cannot be read
      // as one. Not rethrown: the build succeeded.
      log(
        `Failed to report generated file sizes: ${errorMessage(err)}`,
        'error',
      )
    }
  }

  if (everythingSkipped) {
    log(`Design tokens are already up to date (${duration}ms)`, 'success')
    return
  }

  log(
    skipped > 0
      ? `Compiled successfully! (${duration}ms, ${skipped} already up to date)`
      : `Compiled successfully! (${duration}ms)`,
    'success',
  )
}

// Runs one of the consumer's `onBuild*` hooks without letting it decide the
// fate of the build that called it.
//
// Two ways a hook can go wrong, and neither may propagate. A throw is caught
// here, because a post-processing step that fails must not undo a compile the
// plugin itself completed — the files are written and correct. A rejected
// promise is the quieter one: the return value is deliberately not awaited,
// so a rejection has nothing holding it and reaches the host as an unhandled
// rejection, which under Node's default takes the process down — a dev server
// killed from inside a hook that was only meant to reformat a file.
//
// Both are reported at `'error'`, so they are said at every level including
// `silent`, and worded so neither can be read as the compile having failed.
function callHook<A extends unknown[]>(
  log: PluginInstance['log'],
  name: string,
  hook: (...args: A) => Promise<void> | void,
  ...args: A
): void {
  let result: unknown

  try {
    // Captured rather than dropped, because the promise an `async` hook
    // returns is the thing the check below needs. Wrapping this call in a
    // block-bodied arrow — which is what the linter asks for when the return
    // type is plain `void` — discarded it, and the rejection escaped exactly
    // as it had before any of this existed.
    result = hook(...args)
  } catch (err) {
    log(`The ${name} hook threw: ${errorMessage(err)}`, 'error')
    return
  }

  if (!isThenable(result)) return

  void Promise.resolve(result).catch((err: unknown) => {
    log(`The ${name} hook rejected: ${errorMessage(err)}`, 'error')
  })
}

// Throws when `selected` names a platform that `platforms` does not define.
// Named, so a typo is an error rather than a platform silently not built —
// which is what Style Dictionary's own CLI means by "Must be defined in the
// config" — and one function, so the check ahead of the up-to-date skip and
// the one on the build path say exactly the same thing.
function checkSelection(
  item: ResolvedConfig,
  index: number,
  selected: string[] | undefined,
  platforms: Record<string, unknown> | undefined,
): void {
  if (selected === undefined) return

  const defined = Object.keys(platforms ?? {})
  const unknown = selected.filter((name) => !defined.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `${describeConfig(item, index)} does not define the platform(s) ${unknown.join(', ')}. It defines ${defined.join(', ')}.`,
    )
  }
}

// Whether a failure in this compile should be thrown rather than only
// reported. The two compiles are told apart by `runBuilds`'s `context`,
// which only the rebuild paths pass.
function failsTheBuild(
  failOnError: NonNullable<UnpluginStyleDictionaryOptions['failOnError']>,
  context: string | undefined,
): boolean {
  return (
    failOnError === true ||
    (context === undefined ? failOnError === 'build' : failOnError === 'serve')
  )
}

// A hook is the consumer's code, and what it hands back is not this plugin's to
// assume. A predicate rather than `instanceof Promise`, which answers `false`
// for a thenable from another realm or from a promise library — exactly the
// case where letting a rejection escape does the damage.
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

// `volume`, with every path Style Dictionary writes through it noted in
// `into`, resolved as `writtenDestination` resolves a declared one. Each file
// a build writes reaches `promises.writeFile` (`buildPlatform` in
// `lib/StyleDictionary.js`) — a byte-identical one included, since the atomic
// writer decides to skip the rename only once it has been handed the file — so
// `into` ends up holding exactly what the build wrote, and a file it declined
// to write never appears in it. Built per compile, over the atomic volume
// rather than in place of it.
//
// The sync writer is inherited untouched. Only an action reaches it, a
// configuration with actions is never skipped, and `tests/index.test.ts`
// checks that an action is handed the atomic writer itself.
function notingWrites(volume: typeof fs, into: Set<string>): typeof fs {
  const note = (file: unknown) => {
    if (typeof file === 'string') into.add(path.resolve(file))
  }

  /* oxlint-disable typescript/no-unsafe-type-assertion */
  return Object.create(volume, {
    promises: {
      value: Object.create(volume.promises, {
        writeFile: {
          value: async (...args: Parameters<typeof fs.promises.writeFile>) => {
            note(args[0])
            await volume.promises.writeFile(...args)
          },
        },
      }) as typeof fs.promises,
    },
  }) as typeof fs
  /* oxlint-enable typescript/no-unsafe-type-assertion */
}

// Which platforms this compile covers, or `undefined` for all of them.
//
// The array form applies to every build; the object form splits the first
// compile from the watch rebuilds, and `context` is what tells them apart —
// only the rebuild paths pass one. An absent key means every platform, so
// `{ watch: ['css'] }` builds everything once and then only css.
function platformsFor(
  platformsOption: UnpluginStyleDictionaryOptions['platforms'],
  context: string | undefined,
): string[] | undefined {
  if (platformsOption === undefined) return undefined
  if (Array.isArray(platformsOption)) return platformsOption

  return context === undefined ? platformsOption.build : platformsOption.watch
}
