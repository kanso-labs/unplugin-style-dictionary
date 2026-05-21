import type { Config } from 'style-dictionary'
import type { Plugin, ViteDevServer } from 'vite'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import StyleDictionary from 'style-dictionary'

import type { VitePluginStyleDictionaryOptions } from './types.js'

export * from './types.js'

export function vitePluginStyleDictionary(
  options: VitePluginStyleDictionaryOptions = {},
): Plugin {
  const { silent = false } = options
  let viteRoot = process.cwd()

  // Helper to log if not silent
  const log = (
    message: string,
    type: 'error' | 'info' | 'success' = 'info',
  ) => {
    if (silent) return
    const prefix = '[vite-plugin-style-dictionary]'
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
        const fullPath = path.resolve(viteRoot, file)
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
        const fullPath = path.resolve(viteRoot, conf)
        return {
          config: fullPath,
          dir: path.dirname(fullPath),
          file: fullPath,
        }
      } else {
        return {
          config: conf,
          dir: viteRoot,
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
          : path.resolve(viteRoot, pattern)
        filesToWatch.add(absolutePattern.replace(/\\/g, '/'))
      }
    }

    return Array.from(filesToWatch)
  }

  // Compile design tokens
  const runBuilds = async (
    resolvedConfigs: Array<{ config: Config | string; dir: string }>,
  ) => {
    log('Compiling design tokens...', 'info')
    try {
      for (const item of resolvedConfigs) {
        const sd = new StyleDictionary(item.config)
        await sd.buildAllPlatforms()
      }
      log('Compiled successfully!', 'success')
    } catch (err) {
      log(`Compilation failed: ${(err as Error).message}`, 'error')
    }
  }

  return {
    async buildStart() {
      const resolved = await resolveConfigs()
      if (resolved.length > 0) {
        await runBuilds(resolved)
      }
    },

    async configResolved(config) {
      viteRoot = config.root || process.cwd()
    },

    async configureServer(server: ViteDevServer) {
      const resolved = await resolveConfigs()
      if (resolved.length === 0) return

      const filesToWatch = await getWatchFiles(resolved)

      // Watch configuration files and token files
      server.watcher.add(filesToWatch)

      server.watcher.on('all', async (_event, file) => {
        const normalizedFile = file.replace(/\\/g, '/')

        // Check if the modified file matches our watched config or token patterns
        const isConfigOrToken = filesToWatch.some((pattern) => {
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
                pattern
                  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                  .replace(/\*/g, '.*'),
              ).test(normalizedFile))
          )
        })

        if (isConfigOrToken) {
          log(
            `File change detected: ${normalizedFile}. Rebuilding design tokens...`,
            'info',
          )

          // Re-resolve configs to handle added/removed configs or changes to config itself
          const currentResolved = await resolveConfigs()
          await runBuilds(currentResolved)

          // Dynamically update the watch list in case the configurations changed
          const newWatches = await getWatchFiles(currentResolved)
          server.watcher.add(newWatches)
        }
      })
    },

    name: 'vite-plugin-style-dictionary',
  }
}

export default vitePluginStyleDictionary
