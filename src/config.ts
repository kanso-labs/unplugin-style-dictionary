// Where a configuration comes from and what it says: the `config` option
// resolved into a list, each item read as an object, and the form Style
// Dictionary is handed to build from.
//
// Nothing here holds state. One module serves every plugin instance in the
// process, so what an instance owns — its root, its logger, whether it has
// announced a discovery yet — is handed in on each call.

import type { Config } from 'style-dictionary'

import JSON5 from 'json5'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  StyleDictionaryConfigContext,
  UnpluginStyleDictionaryOptions,
} from './types.js'

import { errorMessage } from './errors.js'

// The plugin's logger, narrowed to the two levels anything here reports at. It
// is handed on as a function rather than as the host it writes to, so it goes
// on reading whichever host has claimed the plugin's messages by the time it
// is called.
export type Log = (message: string, type: 'error' | 'info') => void

// A configuration as `resolveConfigOption` hands it on: either the object the
// consumer passed or the path it was read from, plus the directory relative
// paths inside it resolve against.
export interface ResolvedConfig {
  config: Config | string
  file?: string
}

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

// What `new StyleDictionary` is handed for an item. Only a path in the JS
// family becomes an object, because those are exactly the extensions Style
// Dictionary's own `loadFile` reaches with `import` — the ones whose module
// record Node then caches forever, and so the only ones a build could read
// stale. The JSON5 family stays a path because there is nothing to gain:
// those are read from disk on every pass either way, so a build can never
// see one as it stood earlier in the process.
export async function configForBuild(
  item: ResolvedConfig,
): Promise<Config | string> {
  const { config } = item

  if (typeof config !== 'string' || !isImportedConfig(config)) return config

  const loaded = await readConfigObject(item)

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

// What a configuration item says, as an object. `report` is where a failure is
// said, and leaving it out is what stops the two readers of this from saying
// the same thing twice: a bad config has nowhere else to surface when the
// watch list is being built, while a build falls back to handing Style
// Dictionary the path and lets its message through instead.
export async function readConfigObject(
  item: ResolvedConfig,
  report?: Log,
): Promise<Config | null> {
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

    if (report) {
      report(
        `Config file did not resolve to a configuration object: ${item.config}`,
        'error',
      )
    }
  } catch (err) {
    if (report) {
      report(
        `Failed to parse config file: ${item.config}. Error: ${errorMessage(err)}`,
        'error',
      )
    }
  }

  return null
}

// Resolve config file paths / objects
//
// Everything a plugin instance owns arrives as an argument, and none of it is
// kept. `root` is read by the caller on each call because the host assigns it
// after the factory has run, and `configContext` is a function rather than a
// value for the same reason: it is asked only once a consumer's `config`
// function is about to run.
export async function resolveConfigOption({
  config,
  configContext,
  discovery,
  log,
  root,
}: {
  config: UnpluginStyleDictionaryOptions['config']
  configContext: () => StyleDictionaryConfigContext
  discovery: { announced: boolean }
  log: Log
  root: string
}): Promise<ResolvedConfig[]> {
  let rawConfig = config

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
      const candidate = await readConfigObject({
        config: fullPath,
        file: fullPath,
      })

      if (!looksLikeConfig(candidate)) {
        rejected.push(file)
        continue
      }

      // Announced, because "which configuration did it pick" was not
      // answerable from the console at all, and discovery picks from four
      // generic names.
      if (!discovery.announced) {
        discovery.announced = true
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
async function importConfigModule(file: string): Promise<unknown> {
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

// A config file is an untyped boundary: `JSON.parse` and a dynamic `import`
// both hand back `any`, and an `any` assigned to `configObj` spreads through
// every read of it downstream. These two narrow that boundary once, here.
// They are type predicates rather than assertions on purpose — a predicate is
// a check the compiler verifies, where a cast is only a claim.
function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null
}

// Whether a config path is one Style Dictionary imports rather than parses.
function isImportedConfig(file: string): boolean {
  return IMPORTED_CONFIG_EXTENSIONS.some((extension) =>
    file.endsWith(extension),
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

// A config module may expose its config as a `default` export or as the
// namespace itself. `'default' in value` is what lets the compiler reach
// `.default` without a cast.
function unwrapDefault(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'default' in value
    ? (value.default ?? value)
    : value
}
