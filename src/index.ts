import type { Config } from 'style-dictionary'
import type { UnpluginFactory } from 'unplugin'
import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import picomatch from 'picomatch'
import StyleDictionary from 'style-dictionary'
import { glob } from 'tinyglobby'
import { createUnplugin } from 'unplugin'

import type { UnpluginStyleDictionaryOptions } from './types.js'

export type * from './types.js'

// Whether `file` matches one of the resolved config/token watch patterns.
// Shared by the Vite-specific `configureServer` watcher and the universal
// `watchChange` hook — both need it, and both must skip files that don't
// match: without this filter, `watchChange` reacts to *any* changed
// module-graph file, including this plugin's own generated output (since
// consuming code imports it). Every regenerate is itself a "change", which
// without filtering re-triggers a rebuild forever.
//
// Matching a pattern is only half of that, and this function is only the half
// it can answer. A `buildPath` inside a `source` directory is a supported
// layout, and under any correct matcher its output matches the very glob that
// produced it — so the caller also subtracts what the last build wrote. See
// `generatedDestinations` and `isWatchedSource` in the factory below.
//
// The patterns are Style Dictionary's own `source` and `include` globs, so the
// filter has to admit exactly what the build reads — which is why the matching
// is a real globber's rather than hand-rolled. The version this replaces was
// wrong in both directions at once: it stripped `/**` out of a pattern and
// prefix-matched the remainder, so `tokens/**/*.json` matched nothing sitting
// directly in `tokens/` and `tokens/**` matched a `tokens-backup/` sibling,
// while its regex branch mapped every `*` to `.*` — crossing `/` — and tested
// it unanchored, so generated output under a watched directory matched its own
// source glob and rebuilt forever.
//
// picomatch rather than `path.matchesGlob`, which would need no dependency at
// all: that function is documented experimental, and on Node 20 — the floor
// `engines` declares — it prints `ExperimentalWarning: glob is an experimental
// feature and might change at any time` into the consumer's build output. The
// dependency is free in practice, since `unplugin` depends on the same
// picomatch and is already installed wherever this plugin is. Its `dot: false`
// default is deliberate: it is what glob, and so Style Dictionary, reads
// sources with, so a dotfile is invisible to the filter and to the build alike.
export function matchesWatchedFile(file: string, patterns: string[]): boolean {
  const normalizedFile = file.replace(/\\/g, '/')

  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, '/')

    // A config file reaches this function as its own literal path, which is
    // both the common case and the one shape that is not a glob at all.
    return (
      normalizedPattern === normalizedFile ||
      picomatch.isMatch(normalizedFile, normalizedPattern)
    )
  })
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

// `catch` binds `unknown`, and a thrown non-Error — a string, a rejected
// value out of a config module — carries no `.message`. The `as Error` casts
// this replaces claimed otherwise and printed `undefined` for exactly those
// cases, which is the least useful thing a failure log can say.
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

// A configuration as `resolveConfigs` hands it on: either the object the
// consumer passed or the path it was read from, plus the directory relative
// paths inside it resolve against.
interface ResolvedConfig {
  config: Config | string
  dir: string
  file?: string
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

export const unpluginFactory: UnpluginFactory<
  undefined | UnpluginStyleDictionaryOptions,
  false
> = (options = {}) => {
  const { silent = false } = options
  let root = process.cwd()

  // Every absolute destination the last completed build wrote, spelled with
  // forward slashes so it compares against a normalised watcher path. This is
  // the half of the rebuild-loop guard that pattern matching cannot supply:
  // output written under a watched directory matches the source glob that
  // produced it, so without subtracting this set a supported layout rebuilds
  // on its own writes for as long as the dev server runs.
  const generatedDestinations = new Set<string>()

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

  // Helper to log if not silent
  const log = (
    message: string,
    type: 'error' | 'info' | 'success' = 'info',
  ) => {
    if (silent) return
    const prefix = '[unplugin-style-dictionary]'
    if (type === 'error') {
      console.error(`\x1b[31m${prefix} ${message}\x1b[0m`)
    } else if (type === 'success') {
      console.log(`\x1b[32m${prefix} ${message}\x1b[0m`)
    } else {
      console.log(`\x1b[36m${prefix} ${message}\x1b[0m`)
    }
  }

  // Resolve config file paths / objects
  const resolveConfigs = async (): Promise<ResolvedConfig[]> => {
    let rawConfig = options.config

    // If config is not defined, look for default configuration files
    if (!rawConfig) {
      const defaults = [
        'sd.config.json',
        'config.json',
        'sd.config.js',
        'sd.config.mjs',
      ]
      for (const file of defaults) {
        const fullPath = path.resolve(root, file)
        if (fs.existsSync(fullPath)) {
          rawConfig = file
          break
        }
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
      rawConfig = await rawConfig()
    }

    const configs = Array.isArray(rawConfig) ? rawConfig : [rawConfig]

    return configs.map((conf) => {
      if (typeof conf === 'string') {
        const fullPath = path.resolve(root, conf)
        return {
          config: fullPath,
          dir: path.dirname(fullPath),
          file: fullPath,
        }
      } else {
        return {
          config: conf,
          dir: root,
        }
      }
    })
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

      let configObj: Config | null = null

      if (typeof item.config === 'string') {
        try {
          let loaded: unknown

          if (item.config.endsWith('.json')) {
            loaded = JSON.parse(fs.readFileSync(item.config, 'utf-8'))
          } else {
            const fileUrl = pathToFileURL(item.config).href
            // Sequential on purpose: a config module runs arbitrary code at
            // import time — `registerFormat` and friends — and Style
            // Dictionary's registries are global, so importing several at
            // once would interleave those registrations.
            loaded = unwrapDefault(await import(`${fileUrl}?t=${Date.now()}`))
          }

          if (isConfig(loaded)) {
            configObj = loaded
          } else {
            log(
              `Config file did not resolve to a configuration object: ${item.config}`,
              'error',
            )
          }
        } catch (err) {
          log(
            `Failed to parse config file: ${item.config}. Error: ${errorMessage(err)}`,
            'error',
          )
        }
      } else {
        configObj = item.config
      }

      if (configObj) {
        const addPattern = (pattern: unknown) => {
          if (typeof pattern === 'string') {
            const absolutePattern = path.isAbsolute(pattern)
              ? pattern
              : path.resolve(item.dir, pattern)
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

    return { paths: await expandPatterns(patterns), patterns }
  }

  // Compile design tokens
  const runBuilds = async (
    resolvedConfigs: ResolvedConfig[],
    context?: string,
  ) => {
    const startTime = Date.now()
    try {
      if (!context) {
        log('Compiling design tokens...', 'info')
      }

      const generatedFiles = new Set<string>()

      // Configurations are built one after another rather than with
      // `Promise.all`, and that is load-bearing. Two configurations may name
      // the same destination file, and each instance gets the atomic volume
      // swapped onto it below — overlapping builds would interleave those
      // writes and hand a reader a file assembled from both.
      for (const item of resolvedConfigs) {
        const sd = new StyleDictionary(item.config)
        await sd.hasInitialized
        const silentSD = await sd.extend({
          log: {
            verbosity: 'silent',
          },
        })
        // Swap in the atomic volume only now that the instance has finished
        // reading its configs and token sources, so every write below lands
        // through `rename` while the read path stays exactly as it was.
        silentSD.volume = atomicVolume
        await silentSD.buildAllPlatforms()

        // Collected on every build rather than only on the ones whose size
        // report prints it below. The set is also what keeps a rebuild from
        // being triggered by the write it just made, and a rebuild passes a
        // `context` — so gating the collection on `!context` left it empty on
        // exactly the builds a watcher is live for.
        for (const platform of Object.values(silentSD.platforms)) {
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

      const duration = Date.now() - startTime

      if (context) {
        log(
          `Rebuilt design tokens due to change in ${context} (${duration}ms)`,
          'success',
        )
      } else {
        if (!silent && generatedFiles.size > 0) {
          const fileInfos: Array<{
            coloredPath: string
            gzipSizeStr: string
            relativeDisplayPath: string
            sizeStr: string
          }> = []

          for (const filePath of generatedFiles) {
            if (fs.existsSync(filePath)) {
              const displayPath = path
                .relative(root, filePath)
                .replace(/\\/g, '/')
              const dir = path.dirname(displayPath)
              const base = path.basename(displayPath)
              const coloredPath =
                dir === '.'
                  ? `\x1b[32m${base}\x1b[0m`
                  : `\x1b[90m${dir}/\x1b[0m\x1b[32m${base}\x1b[0m`

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
                // Ignore errors reading individual files
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
                Math.max(
                  2,
                  longestPathLength - info.relativeDisplayPath.length + 2,
                ),
              )
              const sizePadded = info.sizeStr.padStart(longestSizeLength)
              console.log(
                `${info.coloredPath}${pathPadding}\x1b[90m${sizePadded} │ gzip: ${info.gzipSizeStr}\x1b[0m`,
              )
            }
          }
        }

        log(`Compiled successfully! (${duration}ms)`, 'success')
      }
    } catch (err) {
      const duration = Date.now() - startTime
      log(
        `Compilation failed after ${duration}ms: ${errorMessage(err)}`,
        'error',
      )
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
  let waiting: Array<() => void> = []

  // Set by `configureServer`. A dev server's watcher is long-lived, so its
  // list has to follow a configuration that changes; every other target
  // re-registers on each build through `addWatchFile` instead.
  let refreshServerWatchList:
    | ((resolved: ResolvedConfig[]) => Promise<void>)
    | undefined

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

      try {
        const resolved = await resolveConfigs()
        if (resolved.length > 0) {
          await runBuilds(resolved, reason)
          hasCompiled = true
          await refreshServerWatchList?.(resolved)
        }
      } catch (err) {
        log(`Rebuild failed: ${errorMessage(err)}`, 'error')
      } finally {
        for (const resolve of resolvers) resolve()
      }
    }
  }

  // Resolves once a rebuild covering this trigger has finished.
  const schedule = async (reason: string): Promise<void> => {
    pendingReason = reason

    const covered = new Promise<void>((resolve) => {
      waiting.push(resolve)
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

      await runBuilds(resolved)
      hasCompiled = true
    },

    name: 'unplugin-style-dictionary',

    vite: {
      configResolved(config) {
        root = config.root || process.cwd()
      },

      async configureServer(server: ViteDevServer) {
        const resolved = await resolveConfigs()
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

        // chokidar types its listener as returning void and does not await
        // what it is handed, so an async listener left every rejection
        // floating. `schedule` owns the whole rebuild including its errors,
        // so there is nothing here left to reject.
        server.watcher.on('all', (_event, file) => {
          if (!isWatchedSource(file, targets.patterns)) return

          void schedule(path.basename(file))
        })
      },
    },

    // Rollup types `watchChange` as returning void, yet awaits it as a
    // sequential hook — and the work here is inherently asynchronous. The
    // signature is the thing that is wrong, so the rule is silenced rather
    // than the hook made to lie about finishing.
    // oxlint-disable-next-line typescript/no-misused-promises
    async watchChange(id) {
      // Raised before any decision about `id`, because whatever this change
      // was, the host is now on its way back into `buildStart`.
      watchRebuild = true

      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      const { patterns } = await getWatchTargets(resolved)
      // Without this check, watchChange fires for *any* changed file in the
      // host bundler's module graph — including our own generated output,
      // since consuming code imports it. Every regenerate is itself a
      // "change", so skipping what is not a source here is what keeps this
      // from rebuilding forever — both the files that match no pattern and
      // the ones that match only because this plugin wrote them.
      if (!isWatchedSource(id, patterns)) return

      await schedule(path.basename(id))

      // Expanded again after the build rather than reusing the list from
      // before it, so a token file the build itself produced is registered.
      for (const file of await expandPatterns(patterns)) {
        this.addWatchFile(file)
      }
    },
  }
}

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
