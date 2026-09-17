import type { Config } from 'style-dictionary'
import type { UnpluginFactory } from 'unplugin'
import type { ViteDevServer } from 'vite'

import JSON5 from 'json5'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import StyleDictionary from 'style-dictionary'
import { glob } from 'tinyglobby'
import { createUnplugin } from 'unplugin'

import type {
  StyleDictionaryConfigContext,
  UnpluginStyleDictionaryOptions,
} from './types.js'

import { matchesWatchedFile } from './watch-filter.js'

export type * from './types.js'

// `catch` binds `unknown`, and a thrown non-Error — a string, a rejected
// value out of a config module — carries no `.message`. The `as Error` casts
// this replaces claimed otherwise and printed `undefined` for exactly those
// cases, which is the least useful thing a failure log can say.
// A rejected promise must carry an Error, and `catch` binds `unknown`. What
// Style Dictionary throws is already one; anything else is wrapped rather than
// handed on raw.
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error))
}

// Whether escapes may be written to this stream.
//
// **The three signals are ordered rather than combined into one conjunction**,
// and that ordering is the whole of it. `FORCE_COLOR=1` on a non-TTY — a CI job
// that wants colour in a log it will render itself — is the single job that
// variable has, and
// `!process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' && stream.isTTY`
// never honours it: the TTY check has the last word and answers `false`.
//
// `NO_COLOR` wins over `FORCE_COLOR` because the convention says so: any
// non-empty value turns colour off, and nothing may turn it back on.
function colourAllowed(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false

  const forced = process.env.FORCE_COLOR
  if (forced === '0') return false
  if (forced !== undefined && forced !== '') return true

  // A terminal that has told us it cannot render escapes. Not one of the three
  // the issue named, but it is what `TERM=dumb` means and it costs a line.
  if (process.env.TERM === 'dumb') return false

  return stream.isTTY === true
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A config file is an untyped boundary: `JSON.parse` and a dynamic `import`
// both hand back `any`, and an `any` assigned to `configObj` spreads through
// every read of it downstream. These two narrow that boundary once, here.
// They are type predicates rather than assertions on purpose — a predicate is
// a check the compiler verifies, where a cast is only a claim.
function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null
}

// A host's message channel, narrowed by a predicate rather than asserted: what
// a plugin context carries under `warn` is the host's business, and a cast
// would only claim it is callable.
function isMessageChannel(value: unknown): value is (message: string) => void {
  return typeof value === 'function'
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

// Whether a discovered file looks like a Style Dictionary configuration at all.
//
// Only applied to a file the plugin went looking for, never to one a consumer
// named: an explicit `config` is their choice and second-guessing it would
// reject shapes Style Dictionary accepts and this does not know about.
//
// `config.json` is an extremely common name for something else entirely, and
// the plugin used to adopt whatever it found under that name, add it to the
// watch set, and report a successful compile over it.
function looksLikeConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false

  // The four keys any usable configuration has at least one of. `platforms`
  // alone is enough because a configuration can declare its tokens inline
  // under `tokens`, or read them through `source`/`include`.
  return ['include', 'platforms', 'source', 'tokens'].some(
    (key) => key in value,
  )
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

function paint(code: string, value: string, allowed: boolean): string {
  return allowed ? `\u001B[${code}m${value}\u001B[0m` : value
}

// Which of a configuration's own `source`/`include` patterns match no file on
// disk. Only for diagnosis: it is the emptiness of the resolved token set that
// decides whether a build fails, because only that catches every route to an
// empty set. This names the pattern at fault, which the token count cannot, and
// it reports a mistyped pattern in a configuration whose others still match —
// where nothing fails at all and one platform quietly loses its tokens.
async function patternsMatchingNothing(patterns: string[]): Promise<string[]> {
  const barren: string[] = []

  for (const pattern of patterns) {
    // A literal path is a `stat`, not a glob: `tinyglobby` treats a path with
    // no magic characters as a literal anyway, and this keeps the common case
    // off the filesystem walk.
    if (!GLOB_CHARACTERS.test(pattern)) {
      if (!fs.existsSync(pattern)) barren.push(pattern)
      continue
    }

    try {
      const matched = await glob([pattern], { absolute: true })
      if (matched.length === 0) barren.push(pattern)
    } catch {
      // A pattern that cannot even be globbed is the build's problem to
      // report; saying it twice, in a diagnostic, helps nobody.
    }
  }

  return barren
}

// A config module may expose its config as a `default` export or as the
// namespace itself. `'default' in value` is what lets the compiler reach
// `.default` without a cast.
function unwrapDefault(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'default' in value
    ? (value.default ?? value)
    : value
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

    await fs.promises.rename(temporary, file)
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

    fs.renameSync(temporary, file)
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

// A pattern is a glob when any of these appear in it. Deliberately the set
// picomatch and tinyglobby act on, since those two are what match and expand
// here — a path containing one of these characters literally is not
// distinguishable from a pattern, and would not be matchable either.
const GLOB_CHARACTERS = /[!*?[\]{}]/

// The config extensions Style Dictionary loads with `import` rather than by
// parsing the file — the `case` list in its own `loadFile`. They are the only
// ones Node's permanent module cache applies to, and so the only ones this
// plugin has to read on the build's behalf.
//
// Everything else Style Dictionary parses as JSON5, including `.json`, and
// this list is what makes the plugin split the same way. Reading the two
// halves apart is what silently unwatched a whole family of configurations:
// a `.json5` or `.jsonc` file went down the import branch and failed there
// while the build succeeded, and a `.json` file carrying a comment or a
// trailing comma failed strict `JSON.parse` for the same reason.
const IMPORTED_CONFIG_EXTENSIONS = ['.js', '.mjs', '.ts']

// A configuration as `resolveConfigs` hands it on: either the object the
// consumer passed or the path it was read from, plus the directory relative
// paths inside it resolve against.
interface ResolvedConfig {
  config: Config | string
  file?: string
}

// How to name a configuration in a message. A path is what a consumer
// recognises; a configuration passed as an object or returned by a function has
// no name, so it is identified by where it sits in the list rather than by a
// stringified dump of itself.
function describeConfig(item: ResolvedConfig, index: number): string {
  return item.file
    ? `The configuration ${item.file}`
    : `The configuration at position ${index + 1}`
}

// Whether a config path is one Style Dictionary imports rather than parses.
function isImportedConfig(file: string): boolean {
  return IMPORTED_CONFIG_EXTENSIONS.some((extension) =>
    file.endsWith(extension),
  )
}

// The leading run of a pattern that contains no glob character —
// `/p/tokens` for `/p/tokens/**/*.json`. Registering it alongside the files
// that match today is what makes a token file created tomorrow visible:
// watching only the current matches can never see a path that did not exist
// when the watcher was built.
function staticParentOf(pattern: string): string {
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex((segment) =>
    GLOB_CHARACTERS.test(segment),
  )

  return firstGlob === -1
    ? path.posix.dirname(pattern)
    : segments.slice(0, firstGlob).join('/')
}

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

// The patterns one configuration reads, resolved the way the build resolves
// them. The same `source`/`include` walk `getWatchTargets` does, for one
// item rather than the whole set — against the working directory, because
// that is where Style Dictionary's own `combineJSON` globs them.
function sourcePatternsOf(configObj: Config): string[] {
  const patterns: string[] = []

  const add = (pattern: unknown) => {
    if (typeof pattern === 'string') {
      patterns.push(
        (path.isAbsolute(pattern)
          ? pattern
          : path.resolve(process.cwd(), pattern)
        ).replace(/\\/g, '/'),
      )
    }
  }

  for (const value of [configObj.source, configObj.include]) {
    if (Array.isArray(value)) value.forEach(add)
    else add(value)
  }

  return patterns
}

// `fs.statSync` without the throw. A file that is missing, or that cannot be
// read, is the same answer to every caller here: nothing to compare against.
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
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
  // webpack is the one target whose `buildStart` does not run before the
  // module graph is resolved: unplugin taps it on `make`, an
  // `AsyncParallelHook` that `EntryPlugin` taps too. The `webpack` key below
  // compiles on `beforeCompile` instead, which webpack awaits before the
  // compilation exists.
  const isWebpack = meta.framework === 'webpack'
  const {
    cache = true,
    errorOverlay = true,
    failOnError = 'build',
    logLevel,
    onBuildEnd,
    onBuildError,
    onBuildStart,
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

  // Whether a failure in this compile should be thrown rather than only
  // reported. The two compiles are told apart by `runBuilds`'s `context`,
  // which only the rebuild paths pass.
  const failsTheBuild = (context: string | undefined): boolean =>
    failOnError === true ||
    (context === undefined ? failOnError === 'build' : failOnError === 'serve')
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

  // What a watcher is handed, and what a changed path is tested against, are
  // not the same list, and conflating them is why a glob source was watched by
  // nothing at all. Every watcher in play takes filenames rather than
  // patterns: Vite's chokidar and rollup's `FileWatcher` are both constructed
  // with `disableGlobbing: true`, Vite's `addWatchFile` drops anything that
  // fails `fs.existsSync`, and webpack never globs `fileDependencies`. So the
  // patterns stay for matching and the paths are expanded for registering.
  const expandPatterns = async (patterns: string[]): Promise<string[]> => {
    const paths = new Set<string>()
    const globs: string[] = []

    for (const pattern of patterns) {
      if (GLOB_CHARACTERS.test(pattern)) {
        globs.push(pattern)

        // Watching the directory as well as its current contents. chokidar
        // reports a creation inside a watched directory, which is the only
        // way a token file added later is ever noticed.
        const parent = staticParentOf(pattern)
        if (parent && fs.existsSync(parent)) paths.add(parent)
      } else {
        paths.add(pattern)
      }
    }

    if (globs.length > 0) {
      try {
        // tinyglobby matches with picomatch, which is what
        // `matchesWatchedFile` tests with, so what is registered here and what
        // is accepted there cannot disagree.
        for (const match of await glob(globs, { absolute: true })) {
          paths.add(match.replace(/\\/g, '/'))
        }
      } catch (err) {
        log(`Failed to expand watch patterns: ${errorMessage(err)}`, 'error')
      }
    }

    return Array.from(paths)
  }

  // Whether a changed file is a token or config source rather than something
  // this plugin just wrote. Both watch entry points ask through here, so
  // neither can react to its own output.
  const isWatchedSource = (file: string, patterns: string[]): boolean =>
    !generatedDestinations.has(file.replace(/\\/g, '/')) &&
    matchesWatchedFile(file, patterns)

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
  const callHook = <A extends unknown[]>(
    name: string,
    hook: (...args: A) => Promise<void> | void,
    ...args: A
  ): void => {
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

  // Resolve config file paths / objects
  const resolveConfigs = async (): Promise<ResolvedConfig[]> => {
    let rawConfig = options.config

    // Checked ahead of the discovery below, and by identity rather than
    // truthiness: `false` is falsy, so the `!rawConfig` test that triggers
    // discovery would treat "do not discover anything" as "go and look".
    if (rawConfig === false) return []

    // If config is not defined, look for default configuration files
    if (!rawConfig) {
      const defaults = [
        'sd.config.json',
        'config.json',
        'sd.config.js',
        'sd.config.mjs',
      ]

      const rejected: string[] = []

      for (const file of defaults) {
        const fullPath = path.resolve(root, file)
        if (!fs.existsSync(fullPath)) continue

        // Read before adopting. For the two `.json` names this is a parse and
        // nothing more; for the two module names it is an import, and the
        // module has already run by the time there is anything to check —
        // which is what `config: false` exists for and why validation alone
        // does not cover them.
        const candidate = await readConfigObject(
          { config: fullPath, file: fullPath },
          false,
        )

        if (!looksLikeConfig(candidate)) {
          rejected.push(file)
          continue
        }

        // Announced, because "which configuration did it pick" was not
        // answerable from the console at all, and discovery picks from four
        // generic names.
        if (!announcedDiscovery) {
          announcedDiscovery = true
          log(`Using the configuration it found at ${fullPath}`, 'info')
        }

        rawConfig = file
        break
      }

      // Said whether or not something usable turned up after them. A skipped
      // candidate is the interesting half of "no configuration found": the
      // file is right there, and the reason it was not used is not guessable.
      if (rejected.length > 0) {
        log(
          `Ignored ${rejected.join(', ')} in ${root}: nothing there declares platforms, source, include or tokens, so it does not look like a Style Dictionary configuration. Name it with the config option if it is one, or set config to false to stop looking.`,
          'error',
        )
      }
    }

    if (!rawConfig) {
      log(
        'No configuration specified and no default config file found. Style Dictionary will not compile.',
        'error',
      )
      return []
    }

    // Evaluate function if provided
    if (typeof rawConfig === 'function') {
      rawConfig = await rawConfig(configContext())
    }

    const configs = Array.isArray(rawConfig) ? rawConfig : [rawConfig]

    return configs.map((conf) => {
      if (typeof conf === 'string') {
        const fullPath = path.resolve(root, conf)
        return { config: fullPath, file: fullPath }
      } else {
        return { config: conf }
      }
    })
  }

  // Imports a config module, re-evaluating it only when the file itself has
  // changed. The query string is what decides that, and it is not decoration:
  // Node's ESM cache is permanent and keyed on the specifier, so a config
  // imported without one is evaluated once and never read again — which is
  // how an edited `.mjs` config went on building the platform map the process
  // started with, for the rest of the session.
  //
  // `Date.now()` fixed that staleness and bought two problems. Every watcher
  // event registered another module record in a map nothing prunes, re-running
  // the config's own `registerFormat` side effects for a file nobody touched.
  // And its millisecond granularity meant an edit landing inside the same
  // millisecond as the previous import shared that import's key, and was
  // served the old module anyway. `mtimeMs` carries sub-millisecond
  // resolution and only moves when the file does.
  const importConfigModule = async (file: string): Promise<unknown> => {
    let version: number
    try {
      version = fs.statSync(file).mtimeMs
    } catch {
      // A config that cannot be stat'd is about to fail its import too. The
      // old key is what keeps that failure the import's to report.
      version = Date.now()
    }

    // The dot goes, and that is not cosmetic. `mtimeMs` is fractional, so the
    // query it produces ends in something that reads as a file extension to
    // anything deriving a loader from the specifier without stripping the
    // query first — `sd.config.ts?t=1789565080284.6606` is then a `.6606`
    // file, and a TypeScript config gets parsed as JavaScript. Replacing the
    // one dot keeps every distinct mtime a distinct key.
    const key = String(version).replace('.', '_')

    // Sequential on purpose: a config module runs arbitrary code at import
    // time — `registerFormat` and friends — and Style Dictionary's registries
    // are global, so importing several at once would interleave those
    // registrations.
    return unwrapDefault(await import(`${pathToFileURL(file).href}?t=${key}`))
  }

  // What a configuration item says, as an object. `report` is what stops the
  // two readers of this from saying the same thing twice: a bad config has
  // nowhere else to surface when the watch list is being built, while a build
  // falls back to handing Style Dictionary the path and lets its message
  // through instead.
  const readConfigObject = async (
    item: ResolvedConfig,
    reportErrors: boolean,
  ): Promise<Config | null> => {
    if (typeof item.config !== 'string') return item.config

    try {
      // JSON5 rather than `JSON.parse`, because that is what Style Dictionary
      // reads these files with — it is a superset, so a plain `.json` config
      // parses identically and one carrying a comment stops being a config
      // the build understands and the watch list does not.
      const loaded: unknown = isImportedConfig(item.config)
        ? await importConfigModule(item.config)
        : JSON5.parse(fs.readFileSync(item.config, 'utf-8'))

      if (isConfig(loaded)) return loaded

      if (reportErrors) {
        log(
          `Config file did not resolve to a configuration object: ${item.config}`,
          'error',
        )
      }
    } catch (err) {
      if (reportErrors) {
        log(
          `Failed to parse config file: ${item.config}. Error: ${errorMessage(err)}`,
          'error',
        )
      }
    }

    return null
  }

  // Parse token files to watch
  const getWatchTargets = async (
    resolvedConfigs: ResolvedConfig[],
  ): Promise<{ paths: string[]; patterns: string[] }> => {
    const filesToWatch = new Set<string>()

    for (const item of resolvedConfigs) {
      if (item.file) {
        filesToWatch.add(item.file.replace(/\\/g, '/'))
      }

      const configObj = await readConfigObject(item, true)

      if (configObj) {
        const addPattern = (pattern: unknown) => {
          if (typeof pattern === 'string') {
            // Against the working directory, because that is where Style
            // Dictionary resolves it: `combineJSON` globs each pattern with
            // no `cwd` of its own. Resolving against the configuration file's
            // directory instead is how the watch list came to name paths the
            // build never reads — a configuration in a subdirectory built
            // correctly and watched nothing at all.
            const absolutePattern = path.isAbsolute(pattern)
              ? pattern
              : path.resolve(process.cwd(), pattern)
            const normalized = absolutePattern.replace(/\\/g, '/')
            filesToWatch.add(normalized)
          }
        }

        if (configObj.source) {
          if (Array.isArray(configObj.source)) {
            configObj.source.forEach(addPattern)
          } else {
            addPattern(configObj.source)
          }
        }

        if (configObj.include) {
          if (Array.isArray(configObj.include)) {
            configObj.include.forEach(addPattern)
          } else {
            addPattern(configObj.include)
          }
        }
      }
    }

    // Add manually configured watch files
    if (options.watch) {
      const extraWatches = Array.isArray(options.watch)
        ? options.watch
        : [options.watch]
      for (const pattern of extraWatches) {
        const absolutePattern = path.isAbsolute(pattern)
          ? pattern
          : path.resolve(root, pattern)
        filesToWatch.add(absolutePattern.replace(/\\/g, '/'))
      }
    }

    const patterns = Array.from(filesToWatch)

    // Recorded here rather than at each call site, so every path that derives
    // a watch list refreshes the one `watchChange` filters against.
    cachedPatterns = patterns

    return { paths: await expandPatterns(patterns), patterns }
  }

  // What `new StyleDictionary` is handed for an item. Only a path in the JS
  // family becomes an object, because those are exactly the extensions Style
  // Dictionary's own `loadFile` reaches with `import` — the ones whose module
  // record Node then caches forever, and so the only ones a build could read
  // stale. The JSON5 family stays a path because there is nothing to gain:
  // those are read from disk on every pass either way, so a build can never
  // see one as it stood earlier in the process.
  const configForBuild = async (
    item: ResolvedConfig,
  ): Promise<Config | string> => {
    const { config } = item

    if (typeof config !== 'string' || !isImportedConfig(config)) return config

    const loaded = await readConfigObject(item, false)

    // A config that could not be read falls back to the path, so the failure
    // stays Style Dictionary's to report — it knows more about why an import
    // failed than this does, a `.ts` config without type stripping especially.
    if (!loaded) return item.config

    // `loadFile` clones what it imports before handing it on, and passing an
    // object skips that. It matters more here than it does there: the module
    // record now outlives the build, and `extend` is called with
    // `mutateOriginal`. Cloning throws on a config carrying functions — an
    // inline transform — and Style Dictionary's own fallback in that case is
    // to use the original, so this one matches it.
    try {
      return structuredClone(loaded)
    } catch {
      return loaded
    }
  }

  // Every absolute destination a configuration declares, read off the
  // configuration itself rather than off an extended Style Dictionary
  // instance. Reading it here is the whole point: constructing the instance
  // is what the skip exists to avoid.
  //
  // Resolved exactly as the build resolves it below, so the two name the same
  // files — a relative `buildPath` against `root`, and a `destination`
  // against that.
  const declaredDestinations = (configObj: Config): string[] => {
    const destinations: string[] = []

    for (const platform of Object.values(configObj.platforms ?? {})) {
      const buildPath = platform.buildPath ?? ''
      const absoluteBuildPath = path.isAbsolute(buildPath)
        ? buildPath
        : path.resolve(root, buildPath)

      for (const file of platform.files ?? []) {
        if (file.destination) {
          destinations.push(
            path.isAbsolute(file.destination)
              ? file.destination
              : path.resolve(absoluteBuildPath, file.destination),
          )
        }
      }
    }

    return destinations
  }

  // A stable identity for one resolved configuration, or `null` where it
  // cannot have one. Functions are serialised by source rather than dropped,
  // because an inline `format` or `transform` is exactly the edit a
  // fingerprint has to notice, and `JSON.stringify` omits a function outright.
  const configFingerprint = (item: ResolvedConfig): null | string => {
    try {
      return JSON.stringify(
        [root, item.file ?? item.config],
        (_key, value: unknown) =>
          typeof value === 'function' ? `[fn]${String(value)}` : value,
      )
    } catch {
      // Circular, or holding a BigInt. It takes no identity rather than a
      // wrong one, so it compiles every time exactly as it did before.
      return null
    }
  }

  // Whether every file a configuration declares is already newer than every
  // file it reads, so its compile can be skipped.
  //
  // Conservative in every direction it can be: anything it cannot establish —
  // a destination that is missing, a source it cannot stat, a configuration
  // declaring no destinations at all — is a reason to build rather than to
  // skip.
  const isUpToDate = async (
    item: ResolvedConfig,
    configObj: Config,
  ): Promise<boolean> => {
    // An action writes what no `destination` names, so there is nothing for
    // the comparison below to check and skipping would leave its work undone.
    const hasActions = Object.values(configObj.platforms ?? {}).some(
      (platform) => (platform.actions?.length ?? 0) > 0,
    )
    if (hasActions) return false

    const destinations = declaredDestinations(configObj)
    if (destinations.length === 0) return false

    // `options.watch` belongs in here as much as `source` does. A consumer
    // names an extra file because something in the build reads it — a custom
    // format's own data file, most obviously — and leaving it out let a change
    // to it be skipped over while the watcher dutifully reported it.
    const extraWatches = options.watch
      ? Array.isArray(options.watch)
        ? options.watch
        : [options.watch]
      : []

    const sources = await expandPatterns([
      ...sourcePatternsOf(configObj),
      ...extraWatches.map((pattern) =>
        (path.isAbsolute(pattern)
          ? pattern
          : path.resolve(root, pattern)
        ).replace(/\\/g, '/'),
      ),
    ])
    if (item.file) sources.push(item.file.replace(/\\/g, '/'))

    if (sources.length === 0) return false

    let newestSource = -Infinity
    let sawFile = false

    for (const source of sources) {
      const stats = statOrNull(source)
      if (!stats) return false

      // Directories are in this list on purpose — `expandPatterns` registers
      // each pattern's static parent so a token file created later is
      // noticed — but their mtime cannot be read as an input signal here. A
      // directory's mtime moves whenever an entry is added or renamed inside
      // it, and the atomic write renames every generated file into place, so
      // a `buildPath` inside a watched directory made the build itself the
      // newest thing the comparison could see. Nothing was ever up to date.
      if (stats.isDirectory()) continue

      sawFile = true
      newestSource = Math.max(newestSource, stats.mtimeMs)
    }

    // Every pattern expanded to directories alone, so nothing was actually
    // read. Style Dictionary would build an empty dictionary from that, and a
    // skip would present the empty result as current.
    if (!sawFile) return false

    let oldestDestination = Infinity
    for (const destination of destinations) {
      const stats = statOrNull(destination)
      if (!stats) return false
      oldestDestination = Math.min(oldestDestination, stats.mtimeMs)
    }

    if (oldestDestination <= newestSource) return false

    // A configuration given as a path has its own file among the sources
    // above, so an edit to it has already been accounted for and the skip
    // holds across processes.
    if (item.file) return true

    // One given as an object or a function has not. Only this process knows
    // what it looked like when those destinations were written, so the skip
    // holds only against a fingerprint recorded here.
    const fingerprint = configFingerprint(item)

    return fingerprint !== null && compiledFingerprints.has(fingerprint)
  }

  // The size-and-gzip table, in a function of its own so that the compile
  // `try` in `runBuilds` can stop before it. Everything here is presentation
  // over files Style Dictionary has already finished writing, so a throw from
  // it is a reporting bug and nothing more.
  const reportSizes = (generatedFiles: Set<string>) => {
    const fileInfos: Array<{
      coloredPath: string
      gzipSizeStr: string
      relativeDisplayPath: string
      sizeStr: string
    }> = []

    for (const filePath of generatedFiles) {
      if (fs.existsSync(filePath)) {
        const displayPath = path.relative(root, filePath).replace(/\\/g, '/')
        const dir = path.dirname(displayPath)
        const base = path.basename(displayPath)
        // The table goes to stdout, so it follows stdout's decision — which
        // is not always stderr's, since the two are redirected separately.
        const coloredPath =
          dir === '.'
            ? paint('32', base, stdoutColour)
            : paint('90', `${dir}/`, stdoutColour) +
              paint('32', base, stdoutColour)

        try {
          const stats = fs.statSync(filePath)
          const bytes = stats.size
          const sizeStr = `${(bytes / 1024).toFixed(2)} kB`

          const content = fs.readFileSync(filePath)
          const gzipBytes = zlib.gzipSync(content).length
          const gzipSizeStr = `${(gzipBytes / 1024).toFixed(2)} kB`

          fileInfos.push({
            coloredPath,
            gzipSizeStr,
            relativeDisplayPath: displayPath,
            sizeStr,
          })
        } catch {
          // One unreadable destination costs its row rather than the table.
          // Deliberately narrower than the caller's `catch`: it covers the
          // three filesystem and gzip calls above and not the arithmetic
          // below, so a padding bug is reported rather than quietly printing
          // short.
        }
      }
    }

    if (fileInfos.length > 0) {
      const longestPathLength = Math.max(
        ...fileInfos.map((f) => f.relativeDisplayPath.length),
        0,
      )
      const longestSizeLength = Math.max(
        ...fileInfos.map((f) => f.sizeStr.length),
        0,
      )

      for (const info of fileInfos) {
        const pathPadding = ' '.repeat(
          Math.max(2, longestPathLength - info.relativeDisplayPath.length + 2),
        )
        const sizePadded = info.sizeStr.padStart(longestSizeLength)
        console.log(
          info.coloredPath +
            pathPadding +
            paint(
              '90',
              `${sizePadded} │ gzip: ${info.gzipSizeStr}`,
              stdoutColour,
            ),
        )
      }
    }
  }

  // Compile design tokens
  const runBuilds = async (
    resolvedConfigs: ResolvedConfig[],
    context?: string,
  ) => {
    const startTime = Date.now()

    // Ahead of the `try` rather than inside it, because the reporting below
    // reads it and that reporting is deliberately outside.
    const generatedFiles = new Set<string>()

    // How many configurations were already up to date. Read by the reporting
    // below, which is why it sits out here with `generatedFiles`.
    let skipped = 0

    try {
      if (!context) {
        log('Compiling design tokens...', 'info')
      }

      // Before anything is resolved or built, and once per build — a watch
      // rebuild is a build, so this fires again for each one.
      if (onBuildStart) callHook('onBuildStart', onBuildStart)

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
        // `false` so a configuration that will not parse says nothing here —
        // the build below hands Style Dictionary the path and lets its own
        // message through, which is more specific than anything this could
        // say.
        const declared = cache ? await readConfigObject(item, false) : null

        if (declared && (await isUpToDate(item, declared))) {
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
          // `false` because a configuration that will not parse never reaches
          // here — the `extend` above would have thrown first.
          const asObject = await readConfigObject(item, false)
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
        // through `rename` while the read path stays exactly as it was.
        sd.volume = atomicVolume
        await sd.buildAllPlatforms()

        // Collected on every build rather than only on the ones whose size
        // report prints it below. The set is also what keeps a rebuild from
        // being triggered by the write it just made, and a rebuild passes a
        // `context` — so gating the collection on `!context` left it empty on
        // exactly the builds a watcher is live for.
        for (const platform of Object.values(sd.platforms)) {
          const buildPath = platform.buildPath ?? ''
          for (const file of platform.files ?? []) {
            if (file.destination) {
              const absoluteBuildPath = path.isAbsolute(buildPath)
                ? buildPath
                : path.resolve(root, buildPath)
              const absoluteDestination = path.isAbsolute(file.destination)
                ? file.destination
                : path.resolve(absoluteBuildPath, file.destination)
              generatedFiles.add(absoluteDestination)
            }
          }
        }

        // Recorded only now, so a configuration whose build threw is never
        // treated as one this process has compiled.
        const fingerprint = configFingerprint(item)
        if (fingerprint !== null) compiledFingerprints.add(fingerprint)
      }

      // Replaced wholesale rather than added to, so a destination dropped from
      // a configuration stops being treated as ours and becomes watchable
      // again. A build that throws never reaches this and leaves the previous
      // set standing, which is the safe direction: the files it wrote before
      // failing are still ours.
      generatedDestinations.clear()
      for (const destination of generatedFiles) {
        generatedDestinations.add(destination.replace(/\\/g, '/'))
      }
    } catch (err) {
      const duration = Date.now() - startTime
      log(
        `Compilation failed after ${duration}ms: ${errorMessage(err)}`,
        'error',
      )

      // Ahead of the throw decision on purpose, so the overlay sees a failure
      // whatever `failOnError` does with it. Under the dev server's default
      // the line below does not throw, and reading the outcome from a caller's
      // `catch` would see a rebuild that looked like it succeeded.
      notifyBuildOutcome?.(asError(err))

      // Ahead of the throw decision for the same reason as the line above: a
      // rebuild under the dev server's default does not throw, and a hook that
      // only fired when something else was about to fail would be silent on
      // exactly the builds a consumer is watching.
      if (onBuildError) callHook('onBuildError', onBuildError, err)

      // Reported, and then rethrown so the host stops. Swallowing it left
      // every target exiting 0 with the previous run's tokens still on disk
      // and in the bundle — a green build shipping stale values.
      if (failsTheBuild(context)) throw err

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
    notifyBuildOutcome?.(null)

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
    if (onBuildEnd) {
      // `toSorted` is what the linter asks for and what this cannot use:
      // `lib` is ES2022 here and `toSorted` is ES2023, so it types as an error
      // even though every Node this package supports has it. The rule guards
      // against mutating an array someone else holds, and this one was built
      // from the set on the line it appears on.
      // oxlint-disable-next-line unicorn/no-array-sort
      const files = Array.from(generatedFiles).sort((left, right) =>
        left.localeCompare(right),
      )
      callHook('onBuildEnd', onBuildEnd, files, duration)
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
        reportSizes(generatedFiles)
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
      await runBuilds(resolvedConfigs)
      return
    }

    const running = compilesInFlight.get(key)
    if (running) {
      await running
      return
    }

    const compile = runBuilds(resolvedConfigs)
    compilesInFlight.set(key, compile)

    try {
      await compile
    } finally {
      compilesInFlight.delete(key)
    }
  }

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
  const REBUILD_DEBOUNCE_MS = 50

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let pendingReason: string | undefined
  let inFlight: Promise<void> | undefined
  let waiting: Array<(failure?: { error: unknown }) => void> = []

  // Set by `configureServer`. A dev server's watcher is long-lived, so its
  // list has to follow a configuration that changes; every other target
  // re-registers on each build through `addWatchFile` instead.
  let refreshServerWatchList:
    | ((resolved: ResolvedConfig[]) => Promise<void>)
    | undefined

  // Whether the discovered path has been announced. Once per plugin instance:
  // `resolveConfigs` runs on every build and rebuild, and a dev server would
  // otherwise repeat the line for the rest of the session.
  let announcedDiscovery = false

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
      let compiling = false

      try {
        const resolved = await resolveConfigs()
        if (resolved.length > 0) {
          compiling = true
          await runBuilds(resolved, reason)
          compiling = false
          hasCompiled = true
          await refreshServerWatchList?.(resolved)
        }
      } catch (err) {
        failure = { error: err }

        // `runBuilds` reports its own failure before rethrowing, so only the
        // other things that can throw here — a `config` function of the
        // consumer's that raises, a watch list that cannot be rebuilt — need
        // reporting. They reach the overlay for the same reason: from the
        // page's point of view the rebuild failed, whichever half of it did.
        if (!compiling) {
          log(`Rebuild failed: ${errorMessage(err)}`, 'error')
          notifyBuildOutcome?.(asError(err))
        }
      }

      // Handed on to whatever awaited this rebuild, which is `watchChange`
      // and so the host under a watching bundler. Vite's dev-server listener
      // has no build to fail and catches it.
      for (const settle of resolvers) settle(failure)
    }
  }

  // Resolves once a rebuild covering this trigger has finished.
  const schedule = async (reason: string): Promise<void> => {
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
    }, REBUILD_DEBOUNCE_MS)

    // A pending rebuild must not be what keeps a process alive; whatever is
    // watching already is.
    debounceTimer.unref()

    return covered
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
      const { paths } = await getWatchTargets(resolved)
      for (const file of paths) {
        this.addWatchFile(file)
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

    vite: {
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

        // Runs once per rebuild rather than once per event, which is why it
        // is handed to the scheduler rather than done in the listener.
        refreshServerWatchList = async (rebuilt) => {
          targets = await getWatchTargets(rebuilt)
          server.watcher.add(targets.paths)
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
          if (!isWatchedSource(file, targets.patterns)) return

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

      // Raised before any decision about `id`, because whatever this change
      // was, the host is now on its way back into `buildStart`.
      watchRebuild = true

      // The cheap half of the decision, taken before anything is resolved.
      // Under Vite the scope this hook sees is the whole project root rather
      // than the module graph, so most of what arrives here has nothing to do
      // with tokens, and resolving every configuration only to discard the
      // answer ran a consumer's `config` function once per unrelated file.
      // Skipped until a build has derived a list to filter against.
      if (cachedPatterns && !isWatchedSource(id, cachedPatterns)) return

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
      if (!isWatchedSource(id, patterns)) return

      // Same division as `buildStart`: on webpack the compile belongs to
      // `beforeCompile`, which has already run for this compilation, so all
      // that is left is to re-register the watch list below.
      if (!isWebpack) await schedule(path.basename(id))

      // Expanded again after the build rather than reusing the list from
      // before it, so a token file the build itself produced is registered.
      for (const file of await expandPatterns(patterns)) {
        this.addWatchFile(file)
      }
    },

    // unplugin calls this inside `apply(compiler)`, one line before it taps
    // `make`, so the root is in place before the first compile. Without it a
    // webpack build whose `context` is not the working directory looked for
    // the configuration in the wrong place and reported ENOENT.
    webpack(compiler) {
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
    },
  }
}

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
