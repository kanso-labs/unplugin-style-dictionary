import type { UnpluginFactory } from 'unplugin'
import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import path from 'node:path'
import { createUnplugin } from 'unplugin'

import type { PluginInstance } from './compile.js'
import type { ResolvedConfig } from './config.js'
import type {
  StyleDictionaryConfigContext,
  UnpluginStyleDictionaryOptions,
} from './types.js'

import { colourAllowed, paint } from './colour.js'
import { runBuilds } from './compile.js'
import { resolveConfigOption } from './config.js'
import { asError, errorMessage } from './errors.js'
import { expandPatterns, watchPatternsOf } from './patterns.js'
import { createScheduler } from './scheduler.js'
import { isWatchedSource } from './watch-filter.js'

export type * from './types.js'

// Where the plugin's own lines go when a host offers somewhere better than the
// console: Vite's `config.logger`, rollup's and rolldown's plugin context, or
// webpack's `compilation`.
//
// **There is no `error` channel that merely reports.** Rollup's `this.error`
// aborts the bundle — measured: a `buildStart` calling it ends the run with
// `THREW: [plugin err-probe] fatal?` — so routing a failure report through it
// would stop every build that reported one and silently override `failOnError`,
// whose entire job is deciding that. A failure is therefore reported on the
// host's warning channel, and whether the build stops stays `failOnError`'s
// decision alone.
interface HostMessenger {
  error: (message: string) => void

  // Optional because not every host has somewhere for a progress line to go.
  // webpack's `stats` carries warnings and errors and nothing else, and
  // `Compiling design tokens...` is neither — so there it stays on the
  // console rather than being dressed up as a warning.
  info?: (message: string) => void
}

// Best-effort cleanup of a temporary file whose write or rename failed. The
// original failure is what the caller reports, so nothing here may throw.
function discardTemporaryFile(temporary: string): void {
  try {
    fs.rmSync(temporary, { force: true })
  } catch {
    // Ignore: a leftover temporary file is not worth masking the real error.
  }
}

// A host's message channel, narrowed by a predicate rather than asserted: what
// a plugin context carries under `warn` is the host's business, and a cast
// would only claim it is callable.
function isMessageChannel(value: unknown): value is (message: string) => void {
  return typeof value === 'function'
}

// Vite builds its dev-server watcher with a fixed ignore list — `**/.git/**`,
// `**/node_modules/**`, `**/test-results/**` and the cache directory — and
// spreads the consumer's own `server.watch.ignored` entries in *after* them.
// Entries are appended, never subtracted, so `server.watcher.add()` cannot
// reach a path an earlier entry already covers.
//
// That makes a token package resolved through `node_modules` — the shape of
// every workspace, `app/node_modules/@acme/tokens` symlinked to
// `packages/tokens` — build correctly once and then never rebuild, with
// nothing said about it. Measured on Vite 6.4.3, 7.3.6 and 8.3.0: zero watcher
// events for an edit, while a token file outside the root but outside
// `node_modules` rebuilt in the same run.
//
// A negation naming the file exactly is what un-ignores it, and is deliberately
// the narrowest form that works. `!**/node_modules/**` would restore the whole
// dependency tree to the watcher.
function nodeModulesNegations(paths: string[]): string[] {
  const negations = new Set<string>()

  for (const file of paths) {
    const normalised = file.replace(/\\/g, '/')
    if (normalised.includes('/node_modules/')) negations.add(`!${normalised}`)
  }

  return Array.from(negations)
}

// The directories holding token files that resolve through `node_modules`.
//
// Vite's ignore list cannot be argued with on Windows. The negation below is
// honoured on Linux and macOS, and there a token inside `node_modules` rebuilds
// through the dev-server watcher like any other. On Windows it is not, and no
// spelling of the negation changes that — measured on a `windows-latest`
// runner: the file path, every ancestor directory, and the package subtree as
// a globstar all leave the edit reaching no rebuild, while the same fixture
// outside `node_modules` rebuilds. `server.watcher.add()` does not reach it
// either, which is the same limit AGENTS.md already records for a path an
// earlier ignore entry covers.
//
// A symlink is *not* what distinguishes them, which is worth stating because it
// is the obvious suspect: a real directory inside `node_modules` fails exactly
// as the symlinked one does, and a symlink outside it succeeds.
//
// So these directories get a watcher of the plugin's own, which Vite's ignore
// list has no say over. It runs on every platform rather than behind a
// `process.platform` check: one path that is exercised everywhere beats a
// Windows-only branch that nothing else executes, and the scheduler already
// collapses the duplicate trigger this produces where the negation also works.
function nodeModulesWatchDirectories(paths: string[]): string[] {
  const directories = new Set<string>()

  for (const file of paths) {
    const normalised = file.replace(/\\/g, '/')
    if (!normalised.includes('/node_modules/')) continue

    // The directory rather than the file: `fs.watch` on a file stops reporting
    // once an editor replaces it by rename, which is what an atomic save does.
    directories.add(path.dirname(normalised))
  }

  return Array.from(directories)
}

// Style Dictionary writes every generated file with a plain `writeFile` on the
// volume it was handed, which truncates the destination and then streams the
// new contents into it. Anything reading that file inside the window sees a
// partial file: a consuming test run whose tokens are rebuilt mid-suite, or a
// dev-server request landing on a rebuild, gets a truncated module and fails
// to parse it. Writing a sibling temporary file and renaming it over the
// destination closes the window — `rename` is atomic within a filesystem, so a
// concurrent reader sees either the whole old file or the whole new one.

// Temporary path for an atomic write of `destination`.
//
// It has to be a sibling of the destination, because `rename` is only atomic
// within one filesystem and the system temp directory is often a different
// mount. The final extension is dropped rather than kept, so the temporary
// file cannot match a pattern written for the generated file's own extension.
// That was load-bearing while `matchesWatchedFile` tested its globs
// unanchored, where a leftover `vars.css.tmp` matched a `*.css` watch; it is
// belt-and-braces now that the matcher anchors and, like the globber Style
// Dictionary reads sources with, does not match the leading dot this name
// already starts with. Both stay, because a temporary file only outlives its
// rename when a write failed, and hiding one costs a string. The pid and
// counter make the name unique, so two writes of the same destination —
// parallel platforms in one build, or two builds overlapping — never share a
// temporary file.
let temporaryFileCounter = 0

// Whether the freshly rendered `temporary` holds exactly what `destination`
// already holds. A rebuild whose inputs did not change renders byte-identical
// output, and renaming that over the destination is a filesystem event the
// host bundler reacts to — which is the whole of the rebuild loop, since
// consuming code imports the generated file and every regenerate is therefore
// a module-graph change. Comparing the two files rather than the `data`
// argument keeps this indifferent to whether the caller passed a string, a
// buffer or a stream, and to the encoding it passed with it.
//
// A destination that cannot be read is not identical, which covers the
// ordinary case of it not existing yet.
async function rendersWhatIsAlreadyThere(
  temporary: string,
  destination: string,
): Promise<boolean> {
  try {
    const [existing, rendered] = await Promise.all([
      fs.promises.readFile(destination),
      fs.promises.readFile(temporary),
    ])

    return existing.equals(rendered)
  } catch {
    return false
  }
}

function rendersWhatIsAlreadyThereSync(
  temporary: string,
  destination: string,
): boolean {
  try {
    return fs.readFileSync(destination).equals(fs.readFileSync(temporary))
  } catch {
    return false
  }
}

function temporaryPathFor(destination: string): string {
  const extension = path.extname(destination)

  return path.join(
    path.dirname(destination),
    `.${path.basename(destination, extension)}.${process.pid}.${temporaryFileCounter++}.tmp`,
  )
}

// Windows refuses a rename over a destination another process holds open, and
// that is exactly the case the atomic write exists to serve: measured on a
// `windows-latest` runner, the suite's own concurrent-reader case fails with
// `EPERM: operation not permitted, rename`. So the feature inverts — the
// compile fails rather than the read being protected.
//
// This **refutes** the reasoning that put the case in doubt. It was argued that
// libuv opens files with `FILE_SHARE_DELETE`, so a concurrent reader would most
// likely not block the rename. It blocks it.
//
// The blocking handle is transient — a reader, an indexer, a virus scanner —
// so a short bounded backoff clears it. The bound matters as much as the retry:
// a rename that genuinely cannot succeed has to fail rather than hang a dev
// server, and the existing failure path already reports and lets `failOnError`
// decide.
//
// Unreachable on Linux and macOS, where a rename over an open file succeeds.
const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM'])

// Doubling rather than a fixed interval, so the common case — a handle already
// gone by the first retry — costs a millisecond rather than the whole budget.
//
// **The total is sized by what a dev server can tolerate waiting, not by how
// long a handle usually persists.** An earlier version stopped at about 255ms,
// which clears a transient hold and is not the situation that matters: a
// consumer polling the generated file holds it for a large fraction of wall
// time, and then no budget wins every race. What that produced was a rebuild
// that failed roughly once in a hundred renames — which the suite's own
// concurrent-reader case turns into a failure about once a run, because it
// performs twenty of them. Intermittent, and on a platform where the whole
// point of the atomic write is that a reader never sees a partial file.
//
// About two seconds is therefore the bound. A rebuild that takes a second is
// something a dev server absorbs; one that fails is not. `write-file-atomic`
// and `graceful-fs` both take this approach, the latter retrying for up to a
// minute, so this is still the conservative end.
//
// The bound stays a bound: a rename that genuinely cannot succeed has to fail
// rather than hang, and the unguarded attempt after the loop is what makes it.
const RENAME_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]

// **The synchronous path gets a shorter budget, and the asymmetry is the
// point.** `renameWithRetry` waits on a timer, so the event loop keeps serving
// while it does; `renameWithRetrySync` waits on `Atomics.wait`, which blocks
// everything — a dev server holding its main thread for two seconds is worse
// than the failed rebuild the wait is trying to avoid.
//
// It is reached only through a Style Dictionary custom action's own
// `vol.writeFileSync`, which is rare, and it keeps roughly the budget the async
// path had before this change.
const RENAME_RETRY_DELAYS_SYNC_MS = [1, 2, 4, 8, 16, 32, 64, 128]

function isRetryableRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RENAME_RETRY_CODES.has(error.code)
  )
}

// `Atomics.wait` rather than a spin on `Date.now()`, because the sync path has
// no event loop to yield to and a busy loop would hold the CPU for the whole
// backoff — on the one platform where the handle it is waiting for belongs to
// another process.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function renameWithRetry(
  temporary: string,
  destination: string,
): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await fs.promises.rename(temporary, destination)
      return
    } catch (err) {
      if (!isRetryableRenameError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  // The last attempt is deliberately outside the loop and unguarded: the bound
  // is a bound, so whatever it throws here is what the caller sees.
  await fs.promises.rename(temporary, destination)
}

function renameWithRetrySync(temporary: string, destination: string): void {
  for (const delay of RENAME_RETRY_DELAYS_SYNC_MS) {
    try {
      fs.renameSync(temporary, destination)
      return
    } catch (err) {
      if (!isRetryableRenameError(err)) throw err
      sleepSync(delay)
    }
  }

  fs.renameSync(temporary, destination)
}

const writeFileAtomic: typeof fs.promises.writeFile = async (
  file,
  data,
  options,
) => {
  // A file handle or descriptor is already-open state that a rename cannot
  // stand in for, so only a path is written atomically.
  if (typeof file !== 'string') {
    return fs.promises.writeFile(file, data, options)
  }

  const temporary = temporaryPathFor(file)

  try {
    await fs.promises.writeFile(temporary, data, options)

    // The check sits in front of the rename rather than in place of it: the
    // temporary file is still written, so a destination that does need
    // replacing is still replaced in one atomic step and a concurrent reader
    // still never sees a partial file.
    if (await rendersWhatIsAlreadyThere(temporary, file)) {
      discardTemporaryFile(temporary)
      return
    }

    await renameWithRetry(temporary, file)
  } catch (err) {
    discardTemporaryFile(temporary)
    throw err
  }
}

const writeFileSyncAtomic: typeof fs.writeFileSync = (file, data, options) => {
  if (typeof file !== 'string') {
    fs.writeFileSync(file, data, options)
    return
  }

  const temporary = temporaryPathFor(file)

  try {
    fs.writeFileSync(temporary, data, options)

    if (rendersWhatIsAlreadyThereSync(temporary, file)) {
      discardTemporaryFile(temporary)
      return
    }

    renameWithRetrySync(temporary, file)
  } catch (err) {
    discardTemporaryFile(temporary)
    throw err
  }
}

// `node:fs` with both write entry points swapped for their atomic
// equivalents, handed to Style Dictionary as the volume it builds through.
// Everything else — reads, `mkdir`, `access`, the `promises` namespace — is
// inherited from `node:fs` unchanged, so only the moment a file becomes
// visible to readers changes. Custom actions receive this volume too, so
// whatever they emit is written the same way.
//
// It is assigned onto the instance rather than passed as the `volume`
// constructor option on purpose: that option marks the volume as a custom
// filesystem shim, which switches Style Dictionary's path resolution off for
// every read as well.
// `Object.create` is declared as returning `any`, so pinning the result to
// `typeof fs` is a claim no type guard can replace. The prototype link is the
// whole point — see the note above — so rebuilding this with a spread, which
// copies own properties and drops the chain, is not a substitute.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const atomicVolume = Object.create(fs, {
  promises: {
    value: Object.create(fs.promises, {
      writeFile: { value: writeFileAtomic },
    }) as typeof fs.promises,
  },
  writeFileSync: { value: writeFileSyncAtomic },
}) as typeof fs
/* oxlint-enable typescript/no-unsafe-type-assertion */

// The fingerprints of configurations this process has compiled at least once.
// It is what lets a configuration given as an object or a function be skipped
// at all: such a configuration has no file to stat, so an edit to it inside
// `vite.config.ts` moves no mtime and the filesystem cannot tell the two
// apart. Having built it here, the plugin can — the fingerprint changes with
// the configuration.
//
// Module scope rather than the factory's, for the same reason `compilesInFlight`
// below is: the instances that would otherwise repeat the work are different
// instances, so per-instance state cannot see them. A `vitest run` stands up
// several, and a function configuration — the form the README recommends for
// registering custom formats — would be the one form that never skipped.
//
// The fingerprint carries the root, so two projects in one process never share
// one. A configuration given as a path needs none of this: its own file is one
// of the sources the mtime comparison reads, so an edit to it is visible across
// processes as well as within one.
const compiledFingerprints = new Set<string>()

// A compile that is running right now, keyed by `buildKey`, so bundler
// instances in one process wait on each other rather than each starting their
// own.
//
// Generated token files are a side effect on the filesystem, not per-bundler
// output, and one process routinely holds several instances of this plugin. A
// single `vitest run` on a project with two test projects and browser mode
// stands up five Vite servers — the root one, one per project, and one more
// per project once its HTTP server listens — and every one of them runs
// `buildStart`. `hasCompiled` cannot see any of that: it is closure state
// inside the factory, so each instance has its own and each compiles.
//
// Module scope is the only place a shared answer can live, since the
// instances know nothing about each other. It stays a claim about identical
// work, never about identity: the key carries the root and the resolved
// configurations, so one script building two packages shares nothing.
const compilesInFlight = new Map<string, Promise<void>>()

// The slice of a webpack-shaped compiler this plugin touches, named rather
// than imported. webpack and rspack each ship their own `Compiler` type, and
// neither is assignable to the other, so a hook written against one cannot be
// handed to the other's key. Both satisfy this structurally, which is what
// makes `adoptCompiler` one function instead of two copies drifting apart.
interface BundlerCompiler {
  hooks: {
    beforeCompile: {
      tapPromise: (name: string, handler: () => Promise<void>) => void
    }
    compilation: {
      tap: (name: string, handler: (compilation: Compilation) => void) => void
    }
    done: { tap: (name: string, handler: () => void) => void }
    failed: { tap: (name: string, handler: () => void) => void }
  }
  options: { context?: string | undefined; mode?: string | undefined }
  watchMode: boolean
}

// Only the one array a report is pushed onto. webpack types it `WebpackError[]`
// and rspack `Error[]`; both are arrays of something extending `Error`, so a
// plain one is what this pushes on either.
interface Compilation {
  warnings: Error[]
}

// A stable identity for a set of resolved configurations, or `null` for one
// that cannot have a stable identity at all.
//
// Functions are serialised by source rather than dropped, because a `format`
// or `transform` written inline is exactly what distinguishes two otherwise
// identical configurations — and `JSON.stringify` omits a function outright,
// which would make two different builds look like one.
function buildKey(root: string, resolved: ResolvedConfig[]): null | string {
  try {
    return JSON.stringify(
      [root, resolved.map((item) => item.file ?? item.config)],
      (_key, value: unknown) =>
        typeof value === 'function' ? `[fn]${String(value)}` : value,
    )
  } catch {
    // A configuration that will not serialise — a circular reference, a
    // BigInt — takes no shared identity rather than a wrong one, and compiles
    // exactly as it did before.
    return null
  }
}

// Not exported. It cannot be called in the form a reader would guess —
// unplugin types the factory as `(options, meta)`, and `meta` is the
// bundler-identifying `UnpluginContextMeta` a consumer would have to build by
// hand — so publishing it offered a name that answered nothing. What a
// consumer imports is the default export of the entry for their bundler.
const unpluginFactory: UnpluginFactory<
  undefined | UnpluginStyleDictionaryOptions,
  false
> = (options = {}, meta) => {
  // webpack and rspack are the targets whose `buildStart` does not run before
  // the module graph is resolved: unplugin taps it on `make`, an
  // `AsyncParallelHook` that `EntryPlugin` taps too. The `webpack` and
  // `rspack` keys below compile on `beforeCompile` instead, which both await
  // before the compilation exists. rspack reimplements webpack's plugin API,
  // so everything this plugin does with a compiler is the same on either —
  // but unplugin dispatches them by separate keys, so the flag names both.
  const isWebpack = meta.framework === 'webpack' || meta.framework === 'rspack'
  const {
    cache = true,
    errorOverlay = true,
    failOnError = 'build',
    logLevel,
    onBuildEnd,
    onBuildError,
    onBuildStart,
    platforms: platformsOption,
    report = true,
    root: rootOption,
    silent = false,
  } = options

  // `silent` predates `logLevel` and names its quietest level, so it is read
  // as one. `logLevel` wins when a consumer sets both.
  const level = logLevel ?? (silent ? 'silent' : undefined)

  // Whether the plugin keeps its own progress lines and size table to itself.
  // A failure is reported at every level, which is why this gate is not on the
  // error branch below.
  const quiet = level === 'silent' || level === 'warn'

  // What Style Dictionary is told, if anything. `undefined` is the point of
  // this: it leaves whatever the consumer's own `log.verbosity` asked for
  // standing, where the plugin used to overwrite it on every build. Style
  // Dictionary has three levels to this option's four, so `'warn'` and
  // `'info'` both map to its default — they differ in what the plugin itself
  // says, not in what Style Dictionary does.
  const verbosity =
    level === undefined
      ? undefined
      : level === 'verbose'
        ? 'verbose'
        : level === 'silent'
          ? 'silent'
          : 'default'

  // What the host is doing, for the function form of `config`. Populated where
  // each host knows the answer and read when that function is called — the
  // same shape as `root` and the message host above, and for the same reason:
  // `resolveConfigs` is reached from five places now, and threading a context
  // parameter through all five would make every caller restate what only the
  // host can say.
  let hostCommand: 'build' | 'serve' = 'build'
  let hostMode: string | undefined
  let isWatching = false

  // `mode` is derived rather than invented where a host has no notion of one.
  // rollup and rolldown report nothing, and following `command` is the answer
  // Vite itself would give: its default mode is `development` serving and
  // `production` building.
  const configContext = (): StyleDictionaryConfigContext => ({
    command: hostCommand,
    mode: hostMode ?? (hostCommand === 'serve' ? 'development' : 'production'),
    watch: isWatching,
  })

  // Whether the host will keep rebuilding, as the plugin context reports it.
  // Read from `meta.watchMode`, which rollup, rolldown and Vite all carry and
  // webpack does not — there it comes off the compiler instead.
  const adoptWatchMode = (context: object): void => {
    const hookMeta: unknown = 'meta' in context ? context.meta : undefined
    if (typeof hookMeta !== 'object' || hookMeta === null) return

    const watching: unknown =
      'watchMode' in hookMeta ? hookMeta.watchMode : undefined
    if (typeof watching === 'boolean') isWatching = watching
  }

  // Where a relative `config` path is looked up. The host sets it below
  // unless the consumer named one, which is why an explicit option wins: a
  // layout the host cannot describe is exactly what it is for.
  let root = rootOption
    ? path.resolve(process.cwd(), rootOption)
    : process.cwd()

  // Every absolute destination the last completed build wrote, spelled with
  // forward slashes so it compares against a normalised watcher path. This is
  // the half of the rebuild-loop guard that pattern matching cannot supply:
  // output written under a watched directory matches the source glob that
  // produced it, so without subtracting this set a supported layout rebuilds
  // on its own writes for as long as the dev server runs.
  const generatedDestinations = new Set<string>()

  // The patterns the last `getWatchTargets` derived. `watchChange` tests a
  // changed path against these before it resolves anything, so a file the
  // plugin does not care about costs one glob match instead of a full config
  // resolution — which, when `config` is a function, is the consumer's own
  // code, and the place the README tells them to register custom formats.
  //
  // It is safe to filter on a list that may be one build out of date because
  // the list always contains the config files themselves: an edit that adds a
  // source matches as a config change, which re-resolves and re-derives. The
  // one thing it cannot see is a `config` function that starts returning
  // different sources with no file changing at all, and that was never
  // observable without a rebuild to observe it in.
  let cachedPatterns: string[] | undefined

  // Whether `watchChange` has fired since the last `buildStart`, and whether
  // anything has been compiled yet. Rollup, rolldown and webpack all run
  // `watchChange` for every changed file and only then re-enter `buildStart`
  // — unplugin's webpack adapter awaits both in one `make` tap — so a flag
  // raised in the first is still standing in the second, and is what tells it
  // this is a watch rebuild rather than the first build of the process.
  let watchRebuild = false
  let hasCompiled = false

  // Whether the host has shut its watcher down. `await watcher.close()` is not
  // a promise that no build is in flight: rollup's `Watcher.close` clears the
  // pending build timeout, closes each task's file watcher and emits `close`,
  // and never awaits `run` — while `Task.run` checks `closed` only *after*
  // `rollupInternal` has resolved. So a build that has already entered
  // `rollupInternal` runs its `buildStart` hooks through to completion after
  // `close()` has returned to its caller, against a project that may be half
  // torn down by then. Measured on rollup 4.63.3 with no plugin of ours: a
  // `buildStart` reading a file 300ms after `close()` resolved gets ENOENT.
  //
  // `closeWatcher` is what makes that answerable. It runs synchronously inside
  // `close()`, and so before the in-flight hook resumes, which is the whole
  // reason a flag set there is worth setting. What it must not be is
  // `closeBundle`: that fires once per bundle — every `BUNDLE_END` a consumer
  // calls `result.close()` on — and would read as a shutdown on every rebuild.
  let hostClosed = false

  // Decided once, when the plugin is constructed, and held for its life. The
  // two streams are asked separately because they are redirected separately —
  // `build 2>err.log` leaves stdout a terminal and stderr a file.
  const stdoutColour = colourAllowed(process.stdout)
  const stderrColour = colourAllowed(process.stderr)

  // Where a message goes once a host has offered somewhere better than the
  // console. Set by `configResolved` under Vite, by the build hooks under
  // rollup and rolldown, and by the `webpack` block; left undefined when no
  // host has claimed it, which is every unit test binding its own context.
  let host: HostMessenger | undefined

  // Adopts a plugin context as the message host, if it has the channels — the
  // unit tests bind a context carrying `addWatchFile` and nothing else, and a
  // hook calling `this.warn` against that throws in a way that reads as a
  // plugin bug rather than as a missing stub.
  //
  // Only when nothing has claimed the host yet. Under Vite `configResolved`
  // has already installed the dev server's own logger, and `buildStart` runs
  // after it with a rollup-shaped context that would otherwise replace it.
  const adoptHost = (context: object): void => {
    if (host) return

    const warn: unknown = 'warn' in context ? context.warn : undefined
    if (!isMessageChannel(warn)) return

    const info: unknown = 'info' in context ? context.info : undefined

    host = {
      // `warn`, never `error`. Rollup's `this.error` aborts the bundle, so
      // reporting through it would stop every build that reported anything and
      // take the decision `failOnError` exists to make.
      error: (message) => {
        warn.call(context, message)
      },
      info: isMessageChannel(info)
        ? (message) => {
            info.call(context, message)
          }
        : undefined,
    }
  }

  // Helper to log at the configured level
  const log = (
    message: string,
    type: 'error' | 'info' | 'success' = 'info',
  ) => {
    const prefix = '[unplugin-style-dictionary]'

    // Ahead of the `silent` gate on purpose. `silent` is about the progress
    // lines and the size table; a compile that failed is not noise, and
    // hiding it left a broken token set shipping with nothing said at all.
    if (type === 'error') {
      // The host renders and colours its own output, so nothing painted here
      // is handed to one — an escape inside a webpack `stats` entry survives
      // into `stats.toJson()` and into whatever reads it.
      if (host) {
        host.error(`${prefix} ${message}`)
        return
      }

      console.error(paint('31', `${prefix} ${message}`, stderrColour))
      return
    }

    if (quiet) return

    if (host?.info) {
      host.info(`${prefix} ${message}`)
      return
    }

    console.log(
      paint(
        type === 'success' ? '32' : '36',
        `${prefix} ${message}`,
        stdoutColour,
      ),
    )
  }

  // Resolve config file paths / objects. The work is `resolveConfigOption`'s;
  // what this adds is the instance it runs for, read at the moment of the call.
  // `root` is assigned by the host after the factory has run, so it is passed
  // as it stands now rather than as it stood when this was built.
  const resolveConfigs = async (): Promise<ResolvedConfig[]> =>
    resolveConfigOption({
      config: options.config,
      configContext,
      discovery,
      log,
      root,
    })

  // Parse token files to watch
  const getWatchTargets = async (
    resolvedConfigs: ResolvedConfig[],
  ): Promise<{ paths: string[]; patterns: string[] }> => {
    const patterns = await watchPatternsOf(
      { log, root, watch: options.watch },
      resolvedConfigs,
    )

    // Recorded here rather than at each call site, so every path that derives
    // a watch list refreshes the one `watchChange` filters against.
    cachedPatterns = patterns

    return { paths: await expandPatterns(patterns, log), patterns }
  }

  // What `runBuilds` reads from this plugin instance, built once. `root` and
  // the overlay callback go in as functions rather than values, because both
  // are assigned after this runs — see `PluginInstance`.
  const instance: PluginInstance = {
    cache,
    compiledFingerprints,
    failOnError,
    generatedDestinations,
    log,
    notifyBuildOutcome: (error) => {
      notifyBuildOutcome?.(error)
    },
    onBuildEnd,
    onBuildError,
    onBuildStart,
    platformsOption,
    quiet,
    report,
    root: () => root,
    stdoutColour,
    verbosity,
    volume: atomicVolume,
    watch: options.watch,
  }

  // `runBuilds` for the first build of a process, with the compile shared
  // between every plugin instance that wants the same one.
  //
  // An instance arriving while a compile for the same key is running waits on
  // that compile instead of starting a second. It is the concurrent half that
  // needs this: an up-to-date check compares what is on disk against the
  // sources, and two instances that start together have nothing on disk to
  // compare against yet, so only a shared promise can tell them apart from
  // two genuinely separate builds.
  //
  // The entry is dropped as soon as the compile settles, so this coalesces
  // rather than caches — a later `buildStart` still compiles. Skipping one
  // whose output is already current is #212's up-to-date check, and belongs
  // with it rather than as a second mechanism here.
  //
  // A rejection reaches every waiter, which is the point: an instance that
  // waited on a failed compile must not carry on as though the tokens were
  // written. Whether that rejection is thrown at all is `failOnError`'s
  // decision, already made inside `runBuilds`.
  const compileOnceAcrossInstances = async (
    resolvedConfigs: ResolvedConfig[],
  ): Promise<void> => {
    const key = buildKey(root, resolvedConfigs)
    if (key === null) {
      await runBuilds(instance, resolvedConfigs)
      return
    }

    const running = compilesInFlight.get(key)
    if (running) {
      await running
      return
    }

    const compile = runBuilds(instance, resolvedConfigs)
    compilesInFlight.set(key, compile)

    try {
      await compile
    } finally {
      compilesInFlight.delete(key)
    }
  }

  // Set by `configureServer`. A dev server's watcher is long-lived, so its
  // list has to follow a configuration that changes; every other target
  // re-registers on each build through `addWatchFile` instead.
  let refreshServerWatchList:
    | ((resolved: ResolvedConfig[]) => Promise<void>)
    | undefined

  // Also set by `configureServer`: closes the `node_modules` watchers it
  // opened. Called from `buildEnd` rather than registered on the server's own
  // shutdown, because nothing on the server fires in every mode — see the
  // `vite` block's `buildEnd`.
  let closeOwnWatchers: (() => void) | undefined

  // Whether the discovered path has been announced. Once per plugin instance:
  // `resolveConfigs` runs on every build and rebuild, and a dev server would
  // otherwise repeat the line for the rest of the session.
  //
  // An object rather than a flag, because it is handed to
  // `resolveConfigOption` to set: that function serves every instance in the
  // process, so the record of what this one has said has to stay here.
  const discovery = { announced: false }

  // Resolved by `configResolved` so it can amend the watcher's ignore list, and
  // handed to `configureServer` rather than resolved again — one start-up, one
  // call of the consumer's `config` function.
  let startupResolved: ResolvedConfig[] | undefined

  // Also set by `configureServer`, and left undefined everywhere else: this is
  // how a compile outcome reaches Vite's error overlay. It is deliberately not
  // the same path as `failOnError`.
  //
  // `failOnError` decides whether the host stops; this decides whether the
  // browser is told. Under a dev server the default is not to stop, so the
  // failure is reported and swallowed — and that is exactly the case where the
  // page is left rendering the last good file with nothing to say it is stale.
  // Reading the outcome off whether `runBuilds` threw would therefore see
  // nothing at all on the only configuration that matters.
  let notifyBuildOutcome: ((error: Error | null) => void) | undefined

  // A rebuild, as the scheduler runs it: resolve, compile, and bring the dev
  // server's watch list up to date. A failure is rethrown once it has been
  // reported, so the scheduler can hand it to every trigger this covered.
  const rebuild = async (reason: string): Promise<void> => {
    let compiling = false

    try {
      const resolved = await resolveConfigs()
      if (resolved.length > 0) {
        compiling = true
        await runBuilds(instance, resolved, reason)
        compiling = false
        hasCompiled = true
        await refreshServerWatchList?.(resolved)
      }
    } catch (err) {
      // `runBuilds` reports its own failure before rethrowing, so only the
      // other things that can throw here — a `config` function of the
      // consumer's that raises, a watch list that cannot be rebuilt — need
      // reporting. They reach the overlay for the same reason: from the
      // page's point of view the rebuild failed, whichever half of it did.
      if (!compiling) {
        log(`Rebuild failed: ${errorMessage(err)}`, 'error')
        notifyBuildOutcome?.(asError(err))
      }

      throw err
    }
  }

  // One rebuild per burst of watcher events, and never two at once — see
  // `createScheduler`. Created here, once per plugin instance: a debounce two
  // instances shared would run one instance's rebuild and drop the other's.
  const schedule = createScheduler({
    debounceMs: 50,
    isClosed: () => hostClosed,
    run: rebuild,
  })

  // Every host that runs a rollup-shaped watcher calls this on shutdown, and
  // all three get the same handler below. There is deliberately no webpack
  // equivalent here: it has no `closeWatcher`, its nearest thing is
  // `compiler.hooks.watchClose`, and nothing measured shows it exposed.
  //
  // It raises the flag and nothing else. A debounce timer armed before the
  // close is deliberately left to fire: the rebuild it runs is one the host
  // asked for while the project was still whole, and `rebuild` reports its
  // own failures. Cancelling it would be a guard no test could fail on, since a
  // trigger arriving after the close is declined by `schedule` instead.
  const closeWatcher = (): void => {
    hostClosed = true
  }

  // What both webpack-shaped hosts do with a compiler, written once.
  // rspack reimplements webpack's plugin API hook for hook, but ships its
  // own `Compiler` type and unplugin dispatches the two through separate
  // keys — so a function typed against either one rejects the other. Naming
  // the surface actually used is what lets one implementation serve both.
  //
  // unplugin calls this inside `apply(compiler)`, one line before it taps
  // `make`, so the root is in place before the first compile. Without it a
  // webpack build whose `context` is not the working directory looked for
  // the configuration in the wrong place and reported ENOENT.
  const adoptCompiler = (compiler: BundlerCompiler): void => {
    if (rootOption === undefined) {
      root = compiler.options.context ?? process.cwd()
    }

    // webpack's `buildStart` context carries no `meta`, so neither half of
    // the build context can come from there. `mode` is a webpack option, and
    // `watchMode` is only true once `watch()` has been called — which is
    // after this runs, so it is read per compile below rather than here.
    hostMode = compiler.options.mode

    // The compile happens in `beforeCompile`, which webpack awaits *before*
    // the compilation exists — so a message from it has nothing to attach to
    // yet and is held until one appears.
    //
    // Only failures are routed. `stats` carries warnings and errors and
    // nothing else, so the progress lines stay on the console rather than
    // being reported as warnings they are not.
    //
    // A warning rather than an error, for the same reason as on rollup: this
    // is the report, and `failOnError` decides separately whether the build
    // stops. Pushing to `compilation.errors` would fail a webpack build that
    // asked not to be failed.
    const pending: string[] = []
    host = {
      error: (message) => {
        pending.push(message)
      },
    }

    compiler.hooks.compilation.tap(
      'unplugin-style-dictionary',
      (compilation) => {
        for (const message of pending.splice(0)) {
          const reported = new Error(message)
          reported.name = 'UnpluginStyleDictionaryWarning'
          compilation.warnings.push(reported)
        }
      },
    )

    // A `beforeCompile` that throws ends the run without ever creating a
    // compilation, and that is exactly the case that produced the message.
    // Left to the buffer it would be reported nowhere at all, so whatever is
    // still held when the run ends goes to the console after all.
    const drainToConsole = () => {
      for (const message of pending.splice(0)) {
        console.error(paint('31', message, stderrColour))
      }
    }
    compiler.hooks.failed.tap('unplugin-style-dictionary', drainToConsole)
    compiler.hooks.done.tap('unplugin-style-dictionary', drainToConsole)

    // `beforeCompile` is awaited before the compilation exists, so the
    // tokens are on disk before webpack resolves the module that imports
    // them. Tapped on every compilation rather than only the first: a watch
    // rebuild needs the same guarantee, and a compile that renders what is
    // already there skips its own write.
    compiler.hooks.beforeCompile.tapPromise(
      'unplugin-style-dictionary',
      async () => {
        isWatching = compiler.watchMode

        const resolved = await resolveConfigs()
        if (resolved.length === 0) return

        await compileOnceAcrossInstances(resolved)
        hasCompiled = true
      },
    )
  }

  return {
    async buildStart() {
      adoptHost(this)
      adoptWatchMode(this)

      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      // Register token/config files with the host bundler's watch mode.
      // Works out of the box wherever the host runs a persistent watcher
      // (e.g. `rollup --watch`). Vite's dev server is additionally handled
      // below via the `vite.configureServer` escape hatch — not because
      // `watchChange` is missing there, which it is not on any Vite this
      // package supports, but because the declared peer range is wider than
      // what has been measured and the scheduler above makes a duplicate
      // trigger free.
      //
      // Skipped outright once the host has closed, because rollup discards the
      // result: with the task closed, `Task.run` returns before
      // `updateWatchedFiles`, so every path registered here goes nowhere. What
      // deriving it does still do is read each config file — with
      // its errors reported — and report an ENOENT for a project the host is
      // in the middle of tearing down. That report was the one thing this
      // block contributed after a close.
      if (!hostClosed) {
        const { paths } = await getWatchTargets(resolved)
        for (const file of paths) {
          this.addWatchFile(file)
        }
      }

      // Registering the watch list is all this hook does on webpack, and it
      // has to happen here rather than beside the compile: `addWatchFile`
      // reaches `compilation.fileDependencies`, and `beforeCompile` runs
      // before there is a compilation to add to. Compiling here as well would
      // put the race back, and run every webpack build twice.
      if (isWebpack) return

      // Every watch rebuild re-enters this hook, and compiling here as well as
      // in `watchChange` is what closed the loop: consuming code imports the
      // generated file, so writing it is itself a module-graph change, which
      // re-enters `buildStart`, which writes it again. `watchChange` has
      // already run for every file in this cycle and rebuilt if any of them
      // was a source, so the only thing left for a re-entry to do is the
      // re-registration above.
      //
      // `hasCompiled` is the floor under that: a host that fires
      // `watchChange` without ever re-entering here would otherwise leave the
      // flag standing, and no first compile of a process may ever be skipped —
      // the tokens have to exist before the build that consumes them.
      if (watchRebuild && hasCompiled) {
        watchRebuild = false
        return
      }

      await compileOnceAcrossInstances(resolved)
      hasCompiled = true
    },

    name: 'unplugin-style-dictionary',

    // `closeWatcher` is a rollup-shaped hook and `UnpluginOptions` declares no
    // top-level equivalent, so it is registered per target instead: rolldown
    // lists it among its input plugin hooks, and Vite's plugin type is
    // rollup's, which is what carries it to `vite build --watch`. Vite's dev
    // server runs no rollup watcher, so there it simply never fires.
    rolldown: { closeWatcher },

    rollup: { closeWatcher },

    // unplugin calls the matching key from inside `apply(compiler)` and
    // never both, so the two share one implementation rather than one
    // delegating to the other.
    rspack: adoptCompiler,

    vite: {
      // **`buildEnd` is the hook a dev server's close reliably reaches.** It
      // replaced `server.httpServer?.once('close', …)`, which middleware mode
      // — Express, Koa, most SSR — has no `httpServer` for, so the optional
      // chain registered nothing and every restart leaked the watchers.
      //
      // Measured on Vite 6.4.3, 7.3.6 and 8.3.0, in middleware mode and
      // listening alike: while a server runs only `buildStart` fires, and on
      // `server.close()` it is `buildEnd` once and `closeBundle` twice.
      // **`closeWatcher` fires in neither mode on any of them**, which is why
      // this is not the `closeWatcher` handler registered below.
      //
      // `buildEnd` also fires at the end of `vite build`, and on every rebuild
      // of `vite build --watch`. Neither runs `configureServer`, so there is
      // nothing to close there and this is a no-op.
      buildEnd() {
        closeOwnWatchers?.()
      },

      closeWatcher,

      async configResolved(config) {
        if (rootOption === undefined) root = config.root || process.cwd()

        // The only host that has both. `command` is what makes `'serve'`
        // reachable at all, since nothing else here serves.
        hostCommand = config.command
        hostMode = config.mode

        // Vite's own logger, so the plugin's lines obey `customLogger` and
        // `clearScreen` like every other line the dev server prints. It
        // colours and prefixes its own output, which is why nothing painted
        // reaches it.
        //
        // Ahead of the early return below, because `vite build` needs the
        // logger just as much and takes that return.
        host = {
          error: (message) => {
            config.logger.error(message)
          },
          info: (message) => {
            config.logger.info(message)
          },
        }

        // Nothing below concerns a build: only the dev server has a watcher,
        // and only its ignore list needs amending.
        if (config.command !== 'serve') return

        // Ahead of the resolution below, so the `config` function a consumer
        // wrote is told `watch: true` on this call as well as on every later
        // one. Setting it in `configureServer` alone was correct until this
        // hook started resolving configurations too.
        isWatching = true

        // **This is the last hook that can reach the ignore list.** Vite
        // builds the watcher from the resolved config, and `configureServer`
        // runs after it exists — `server.watcher` is a parameter there — so a
        // negation added then changes nothing. Measured on Vite 6.4.3, 7.3.6
        // and 8.3.0: amending it here reaches the watcher on all three, and
        // amending it in `configureServer` does not.
        //
        // The resolution is kept for `configureServer` to reuse rather than
        // discarded, because resolving is how a `config` function gets called
        // and doing it twice in one start-up would call the consumer's code an
        // extra time for nothing.
        try {
          startupResolved = await resolveConfigs()
          if (startupResolved.length === 0) return

          const { paths } = await getWatchTargets(startupResolved)
          const negations = nodeModulesNegations(paths)
          if (negations.length === 0) return

          // Appended to whatever the consumer asked for, not replacing it.
          const existing = config.server.watch?.ignored
          config.server.watch = {
            ...config.server.watch,
            ignored: [
              ...(Array.isArray(existing)
                ? existing
                : existing === undefined
                  ? []
                  : [existing]),
              ...negations,
            ],
          }
        } catch (err) {
          // A configuration that cannot be resolved is the build's problem to
          // report, and it will: `buildStart` resolves again and fails there
          // with the host watching. Throwing here would fail the dev server
          // before it started, for the sake of a watch-list refinement.
          log(
            `Could not read the configuration while preparing the watch list: ${errorMessage(err)}`,
            'error',
          )
          startupResolved = undefined
        }
      },

      async configureServer(server: ViteDevServer) {
        // A dev server watches, by definition. Said here rather than left to
        // `adoptWatchMode` because this hook runs *before* `buildStart` —
        // `createServer` calls it, and `buildStart` waits for the plugin
        // container — so the first `config` function of the process would
        // otherwise be told `watch: false` while a dev server started up
        // around it.
        isWatching = true

        // `configResolved` has already resolved these, on its way to amending
        // the watcher's ignore list. Taken rather than copied, so a later
        // rebuild re-resolves as it always did.
        const resolved = startupResolved ?? (await resolveConfigs())
        startupResolved = undefined
        if (resolved.length === 0) return

        // Reassigned after every rebuild below, so a configuration that gains
        // a source is matched against its new patterns rather than the ones
        // read at start-up.
        let targets = await getWatchTargets(resolved)

        // Watch configuration files and token files
        server.watcher.add(targets.paths)

        // The `node_modules` half, which Vite's watcher cannot be made to
        // deliver on Windows — see `nodeModulesWatchDirectories`. Keyed by
        // directory so a configuration that changes can close the ones it no
        // longer needs rather than accumulating watchers for the session.
        const ownWatchers = new Map<string, fs.FSWatcher>()

        const watchNodeModules = (forPaths: string[]) => {
          const wanted = new Set(nodeModulesWatchDirectories(forPaths))

          for (const [directory, watcher] of ownWatchers) {
            if (wanted.has(directory)) continue
            watcher.close()
            ownWatchers.delete(directory)
          }

          for (const directory of wanted) {
            if (ownWatchers.has(directory)) continue

            try {
              const watcher = fs.watch(directory, (_event, filename) => {
                if (filename === null) return

                const changed = path.posix.join(directory, filename)
                if (
                  !isWatchedSource(
                    changed,
                    targets.patterns,
                    generatedDestinations,
                  )
                )
                  return

                void schedule(path.basename(changed)).catch(() => {})
              })

              // A watcher of ours must not be what keeps a process alive; the
              // dev server already is.
              watcher.unref()
              ownWatchers.set(directory, watcher)
            } catch {
              // A directory that cannot be watched is not a reason to fail a
              // dev server. Where the negation works — Linux, macOS — Vite's
              // own watcher is still delivering these events.
            }
          }
        }

        watchNodeModules(targets.paths)

        // Clearing the map is what makes this safe to call more than once.
        closeOwnWatchers = () => {
          for (const watcher of ownWatchers.values()) watcher.close()
          ownWatchers.clear()
        }

        // Runs once per rebuild rather than once per event, which is why it
        // is handed to the scheduler rather than done in the listener.
        refreshServerWatchList = async (rebuilt) => {
          targets = await getWatchTargets(rebuilt)
          server.watcher.add(targets.paths)
          watchNodeModules(targets.paths)
        }

        if (errorOverlay) {
          // Whether the page is currently showing an overlay this plugin put
          // there. Only the clearing frame reads it: a success that follows a
          // success has no overlay to take down, and sending an update frame
          // for it would be traffic for nothing — and would spend the client's
          // one-time `isFirstUpdate`, which Vite uses to decide that an
          // overlay standing at the first update means a full reload.
          let overlayShowing = false

          notifyBuildOutcome = (error) => {
            if (error) {
              // Sent on every failure rather than only on the transition into
              // one. Vite's client replaces the overlay wholesale, so a repeat
              // is idempotent — and two different failures in a row must not
              // leave the first one's message on screen describing the second.
              overlayShowing = true
              server.hot.send({
                err: {
                  message: error.message,
                  plugin: 'unplugin-style-dictionary',
                  stack: error.stack ?? '',
                },
                type: 'error',
              })
              return
            }

            if (!overlayShowing) return
            overlayShowing = false

            // Vite's protocol has no frame for "take the overlay down". The
            // client clears it when an update arrives, so an update carrying
            // nothing is the clear: it dismisses the overlay and then iterates
            // an empty list, reloading no page and touching no stylesheet.
            server.hot.send({ type: 'update', updates: [] })
          }
        }

        // chokidar types its listener as returning void and does not await
        // what it is handed, so an async listener left every rejection
        // floating. `schedule` owns the whole rebuild including its errors,
        // so there is nothing here left to reject.
        server.watcher.on('all', (_event, file) => {
          if (!isWatchedSource(file, targets.patterns, generatedDestinations))
            return

          // A dev server has no build to fail, so a rebuild that throws is
          // reported by the scheduler and the server keeps serving.
          void schedule(path.basename(file)).catch(() => {})
        })
      },
    },

    // Rollup types `watchChange` as returning void, yet awaits it as a
    // sequential hook — and the work here is inherently asynchronous. The
    // signature is the thing that is wrong, so the rule is silenced rather
    // than the hook made to lie about finishing.
    // oxlint-disable-next-line typescript/no-misused-promises
    async watchChange(id) {
      adoptHost(this)
      adoptWatchMode(this)

      // Ahead of everything, including the flag below: a change reported
      // after the watcher closed earns no rebuild, so there is no re-entry
      // into `buildStart` for a flag to describe.
      if (hostClosed) return

      // Raised before any decision about `id`, because whatever this change
      // was, the host is now on its way back into `buildStart`.
      watchRebuild = true

      // The cheap half of the decision, taken before anything is resolved.
      // Under Vite the scope this hook sees is the whole project root rather
      // than the module graph, so most of what arrives here has nothing to do
      // with tokens, and resolving every configuration only to discard the
      // answer ran a consumer's `config` function once per unrelated file.
      // Skipped until a build has derived a list to filter against.
      if (
        cachedPatterns &&
        !isWatchedSource(id, cachedPatterns, generatedDestinations)
      )
        return

      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      // Derived again rather than trusted from the cache, because the cache
      // is what decided this path was worth resolving and not what decides a
      // rebuild. A config edit reaches here through its own filename and can
      // have dropped the very source the cached list matched.
      const { patterns } = await getWatchTargets(resolved)
      // Without this check, watchChange fires for *any* changed file in the
      // host bundler's module graph — including our own generated output,
      // since consuming code imports it. Every regenerate is itself a
      // "change", so skipping what is not a source here is what keeps this
      // from rebuilding forever — both the files that match no pattern and
      // the ones that match only because this plugin wrote them.
      if (!isWatchedSource(id, patterns, generatedDestinations)) return

      // Same division as `buildStart`: on webpack the compile belongs to
      // `beforeCompile`, which has already run for this compilation, so all
      // that is left is to re-register the watch list below.
      if (!isWebpack) await schedule(path.basename(id))

      // Expanded again after the build rather than reusing the list from
      // before it, so a token file the build itself produced is registered.
      for (const file of await expandPatterns(patterns, log)) {
        this.addWatchFile(file)
      }
    },

    webpack: adoptCompiler,
  }
}

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
