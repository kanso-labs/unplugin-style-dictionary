import type { Config } from 'style-dictionary'
import type { UnpluginFactory } from 'unplugin'
import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import StyleDictionary from 'style-dictionary'
import { createUnplugin } from 'unplugin'

import type { UnpluginStyleDictionaryOptions } from './types.js'

export * from './types.js'

// Whether `file` matches one of the resolved config/token watch patterns.
// Shared by the Vite-specific `configureServer` watcher and the universal
// `watchChange` hook — both need it, and both must skip files that don't
// match: without this filter, `watchChange` reacts to *any* changed
// module-graph file, including this plugin's own generated output (since
// consuming code imports it). Every regenerate is itself a "change", which
// without filtering re-triggers a rebuild forever.
export function matchesWatchedFile(file: string, patterns: string[]): boolean {
  const normalizedFile = file.replace(/\\/g, '/')

  return patterns.some((pattern) => {
    // If the pattern is an exact file path
    if (pattern === normalizedFile) return true

    // If the pattern is a glob, we check if the file matches it.
    // Note: A simple string match or simple glob matcher can be used here.
    // For simplicity and correctness, since token source paths are usually globs,
    // we can match based on path directory containment or general matching.
    // Let's implement a robust matchesGlob check or check if it's one of the token files.
    // Chokidar triggers on actual files, so we want to check if the changed file matches
    // any of the config files or token files/globs.
    return (
      normalizedFile.startsWith(pattern.replace(/\/\*\*/g, '')) ||
      (pattern.includes('*') &&
        new RegExp(
          pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
        ).test(normalizedFile))
    )
  })
}

// Style Dictionary writes every generated file with a plain `writeFile` on the
// volume it was handed, which truncates the destination and then streams the
// new contents into it. Anything reading that file inside the window sees a
// partial file: a consuming test run whose tokens are rebuilt mid-suite, or a
// dev-server request landing on a rebuild, gets a truncated module and fails
// to parse it. Writing a sibling temporary file and renaming it over the
// destination closes the window — `rename` is atomic within a filesystem, so a
// concurrent reader sees either the whole old file or the whole new one.

// Best-effort cleanup of a temporary file whose write or rename failed. The
// original failure is what the caller reports, so nothing here may throw.
function discardTemporaryFile(temporary: string): void {
  try {
    fs.rmSync(temporary, { force: true })
  } catch {
    // Ignore: a leftover temporary file is not worth masking the real error.
  }
}

// Temporary path for an atomic write of `destination`.
//
// It has to be a sibling of the destination, because `rename` is only atomic
// within one filesystem and the system temp directory is often a different
// mount. The final extension is dropped rather than kept, so the temporary
// file cannot match a pattern written for the generated file's own extension —
// `matchesWatchedFile` tests its globs unanchored, and a leftover
// `vars.css.tmp` would match a `*.css` watch. The pid and counter make the
// name unique, so two writes of the same destination — parallel platforms in
// one build, or two builds overlapping — never share a temporary file.
let temporaryFileCounter = 0

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
const atomicVolume = Object.create(fs, {
  promises: {
    value: Object.create(fs.promises, {
      writeFile: { value: writeFileAtomic },
    }) as typeof fs.promises,
  },
  writeFileSync: { value: writeFileSyncAtomic },
}) as typeof fs

export const unpluginFactory: UnpluginFactory<
  undefined | UnpluginStyleDictionaryOptions,
  false
> = (options = {}) => {
  const { silent = false } = options
  let root = process.cwd()

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
  const resolveConfigs = async (): Promise<
    Array<{ config: Config | string; dir: string; file?: string }>
  > => {
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
  const getWatchFiles = async (
    resolvedConfigs: Array<{
      config: Config | string
      dir: string
      file?: string
    }>,
  ): Promise<string[]> => {
    const filesToWatch = new Set<string>()

    for (const item of resolvedConfigs) {
      if (item.file) {
        filesToWatch.add(item.file.replace(/\\/g, '/'))
      }

      let configObj: Config | null = null

      if (typeof item.config === 'string') {
        try {
          if (item.config.endsWith('.json')) {
            const content = fs.readFileSync(item.config, 'utf-8')
            configObj = JSON.parse(content)
          } else {
            const fileUrl = pathToFileURL(item.config).href
            const module = await import(`${fileUrl}?t=${Date.now()}`)
            configObj = module.default || module
          }
        } catch (err) {
          log(
            `Failed to parse config file: ${item.config}. Error: ${(err as Error).message}`,
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

    return Array.from(filesToWatch)
  }

  // Compile design tokens
  const runBuilds = async (
    resolvedConfigs: Array<{ config: Config | string; dir: string }>,
    context?: string,
  ) => {
    const startTime = Date.now()
    try {
      if (!context) {
        log('Compiling design tokens...', 'info')
      }

      const generatedFiles = new Set<string>()

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

        if (!context && !silent && silentSD.platforms) {
          for (const platformName of Object.keys(silentSD.platforms)) {
            const platform = silentSD.platforms[platformName]
            if (platform && platform.files) {
              const buildPath = platform.buildPath || ''
              for (const file of platform.files) {
                if (file && file.destination) {
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
        }
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
        `Compilation failed after ${duration}ms: ${(err as Error).message}`,
        'error',
      )
    }
  }

  return {
    async buildStart() {
      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      // Register token/config files with the host bundler's watch mode.
      // Works out of the box wherever the host runs a persistent watcher
      // (e.g. `rollup --watch`); Vite's dev server is additionally handled
      // below via the `vite.configureServer` escape hatch, since token
      // sources are plain JSON/JS files outside the module graph and
      // `watchChange` is not reliably invoked by Vite while serving.
      const watchFiles = await getWatchFiles(resolved)
      for (const file of watchFiles) {
        this.addWatchFile(file)
      }

      await runBuilds(resolved)
    },

    name: 'unplugin-style-dictionary',

    vite: {
      configResolved(config) {
        root = config.root || process.cwd()
      },

      async configureServer(server: ViteDevServer) {
        const resolved = await resolveConfigs()
        if (resolved.length === 0) return

        const filesToWatch = await getWatchFiles(resolved)

        // Watch configuration files and token files
        server.watcher.add(filesToWatch)

        server.watcher.on('all', async (_event, file) => {
          if (!matchesWatchedFile(file, filesToWatch)) return

          // Re-resolve configs to handle added/removed configs or changes to config itself
          const currentResolved = await resolveConfigs()
          await runBuilds(currentResolved, path.basename(file))

          // Dynamically update the watch list in case the configurations changed
          const newWatches = await getWatchFiles(currentResolved)
          server.watcher.add(newWatches)
        })
      },
    },

    async watchChange(id) {
      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      const watchFiles = await getWatchFiles(resolved)
      // Without this check, watchChange fires for *any* changed file in the
      // host bundler's module graph — including our own generated output,
      // since consuming code imports it. Every regenerate is itself a
      // "change", so skipping non-matching files here is what keeps this
      // from rebuilding forever.
      if (!matchesWatchedFile(id, watchFiles)) return

      await runBuilds(resolved, path.basename(id))

      for (const file of watchFiles) {
        this.addWatchFile(file)
      }
    },
  }
}

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
