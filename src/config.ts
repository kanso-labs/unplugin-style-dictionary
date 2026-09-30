// Where a configuration comes from and what it says: the `config` option
// resolved into a list, each item read as an object, and the form Style
// Dictionary is handed to build from.
//
// Nothing here holds state. One module serves every plugin instance in the
// process, so what an instance owns — its root, its logger, whether it has
// announced a discovery yet — is handed in on each call.

import type { Config } from 'style-dictionary'
import type { DesignTokens } from 'style-dictionary/types'

import JSON5 from 'json5'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import StyleDictionary from 'style-dictionary'

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
  // The files the plugin's `watch` option names, expanded. A config module's
  // import is keyed on their mtimes beside its own, so a data file it reads
  // at load time — and that a consumer named in `watch` to trigger a rebuild
  // — re-evaluates it rather than only rebuilding with what it read before.
  watched?: string[]
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

// What `new StyleDictionary` is handed for an item: always an object, carrying
// the plugin's own parser for token modules — see `withTokenModuleParser`.
//
// A path in the JS family is read here because those are exactly the
// extensions Style Dictionary's own `loadFile` reaches with `import`, whose
// module record Node then caches forever, so a build handed the path could
// read the config stale. A JSON5-family path is read here too, so the parser
// can ride along; Style Dictionary would have parsed the same file the same
// way.
export async function configForBuild(
  item: ResolvedConfig,
): Promise<Config | string> {
  const { config } = item

  if (typeof config !== 'string') return withTokenModuleParser(config)

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
  if (!isImportedConfig(config)) return withTokenModuleParser(loaded)

  try {
    return withTokenModuleParser(structuredClone(loaded))
  } catch {
    return withTokenModuleParser(loaded)
  }
}

// The name the plugin's token-module parser is registered and applied under.
const TOKEN_MODULE_PARSER = 'unplugin-style-dictionary/token-module'

// Matches a `.js`, `.mjs` or `.ts` token source, unless another parser the
// configuration applies matches it too. Style Dictionary runs every parser
// whose pattern matches and keeps the last result, and a global parser comes
// ahead of a configuration's own whatever the order in `parsers` — measured,
// `['plugin-own', 'consumer-global']` ran in the order
// `['consumer-global', 'plugin-own']`. So order cannot make the consumer's
// win, and stepping aside is what does. A `RegExp` whose `Symbol.match` is
// overridden, because `filePath.match(pattern)` is how Style Dictionary asks.
class TokenModulePattern extends RegExp {
  private readonly others: RegExp[]

  constructor(others: RegExp[]) {
    super(String.raw`\.(?:js|mjs|ts)$`)
    this.others = others
  }

  override [Symbol.match](value: string): null | RegExpMatchArray {
    if (this.others.some((other) => value.match(other) !== null)) return null

    return super[Symbol.match](value)
  }
}

// How to name a configuration in a message. A path is what a consumer
// recognises; a configuration passed as an object or returned by a function has
// no name, so it is identified by where it sits in the list rather than by a
// stringified dump of itself.
export function describeConfig(item: ResolvedConfig, index: number): string {
  return item.file
    ? `The configuration ${item.file}`
    : `The configuration at position ${index + 1}`
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
      ? await importConfigModule(item.config, item.watched)
      : JSON5.parse(fs.readFileSync(item.config, 'utf-8'))

    if (isConfig(loaded)) return loaded

    if (report) {
      report(
        `Config file did not resolve to a configuration object: ${item.config}`,
        'error',
      )
    }
  } catch (err) {
    // Asked only once reading has failed, and of the file rather than the
    // error: a module config that imports something missing fails with the
    // same code as a config that is not there at all.
    if (report) {
      report(
        fs.existsSync(item.config)
          ? `Failed to parse config file: ${item.config}. Error: ${errorMessage(err)}`
          : `Config file not found: ${item.config}`,
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
      // generic names. A candidate skipped on the way is named here rather
      // than as an error: the build has a configuration, and the advice is
      // to name it, since `config: false` would stop discovery finding it.
      if (!discovery.announced) {
        discovery.announced = true
        log(
          rejected.length > 0
            ? `Using the configuration it found at ${fullPath}, after ignoring ${rejected.join(', ')}: nothing there declares platforms, source, include or tokens. Name ${file} with the config option to stop looking.`
            : `Using the configuration it found at ${fullPath}`,
          'info',
        )
      }

      rawConfig = file
      break
    }

    // A skipped candidate is the interesting half of "no configuration
    // found": the file is right there, and the reason it was not used is not
    // guessable.
    if (!rawConfig && rejected.length > 0) {
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
//
// Keyed on the files the plugin's `watch` option names as well: a config that
// reads a data file at load time went on building what that file said at
// startup. A module the config itself imports is out of reach — a new query
// on the config re-evaluates the config, not what it imports — so naming one
// in `watch` buys a rebuild and not a re-read.
async function importConfigModule(
  file: string,
  watched: string[] = [],
): Promise<unknown> {
  const key = versionKey([file, ...watched])

  // Sequential on purpose: a config module runs arbitrary code at import
  // time — `registerFormat` and friends — and Style Dictionary's registries
  // are global, so importing several at once would interleave those
  // registrations.
  return unwrapDefault(await import(`${pathToFileURL(file).href}?t=${key}`))
}

// A token module, read the way `importConfigModule` reads a config: under a
// query keyed on its mtime, and cloned as Style Dictionary's own `loadFile`
// clones it. Style Dictionary reads one with a bare `import`, and Node's
// module cache keeps that first evaluation for the life of the process — so
// under a long-lived watcher an edited `.mjs` token file rebuilt, reported
// success, and wrote the values the process started with.
async function importTokenModule(
  filePath: string | undefined,
): Promise<DesignTokens> {
  if (filePath === undefined) return {}

  const module: unknown = await import(
    `${pathToFileURL(filePath).href}?t=${versionKey([filePath])}`
  )

  // `.default`, exactly as `loadFile` reads it: a module without one carries
  // no tokens.
  const tokens: unknown =
    typeof module === 'object' && module !== null && 'default' in module
      ? module.default
      : undefined
  if (!isTokens(tokens)) return {}

  try {
    return structuredClone(tokens)
  } catch {
    return tokens
  }
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

function isTokens(value: unknown): value is DesignTokens {
  return typeof value === 'object' && value !== null
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

// The cache key for a module read under `files`: the newest of their mtimes.
//
// The dot goes, and that is not cosmetic. `mtimeMs` is fractional, so the
// query it produces ends in something that reads as a file extension to
// anything deriving a loader from the specifier without stripping the query
// first — `sd.config.ts?t=1789565080284.6606` is then a `.6606` file, and a
// TypeScript config gets parsed as JavaScript. Replacing the one dot keeps
// every distinct mtime a distinct key.
//
// A file that cannot be stat'd is about to fail its import too, and falls
// back to the time now, which keeps that failure the import's to report.
function versionKey(files: string[]): string {
  let newest = -1
  for (const file of files) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs)
    } catch {
      // Named, and not there: a data file created later is fine to miss.
    }
  }

  return String(newest < 0 ? Date.now() : newest).replace('.', '_')
}

// `config` with the plugin's token-module parser registered in `hooks.parsers`
// and named in `parsers` — Style Dictionary applies a parser only when both
// are true. A copy, so the consumer's object is not changed.
function withTokenModuleParser(config: Config): Config {
  const applied = config.parsers ?? []

  // The patterns of every other parser the configuration applies, from its
  // own hooks or the global registry, since either can be named.
  // Typed partial, because a name nothing registered indexes to nothing.
  const own: Partial<Record<string, { pattern: RegExp }>> =
    config.hooks?.parsers ?? {}
  const registered: Partial<Record<string, { pattern: RegExp }>> =
    StyleDictionary.hooks.parsers
  const others = applied.flatMap((name) => {
    const parser = own[name] ?? registered[name]
    return parser ? [parser.pattern] : []
  })

  return {
    ...config,
    hooks: {
      ...config.hooks,
      parsers: {
        ...config.hooks?.parsers,
        [TOKEN_MODULE_PARSER]: {
          parser: async ({ filePath }) => importTokenModule(filePath),
          pattern: new TokenModulePattern(others),
        },
      },
    },
    parsers: [...applied, TOKEN_MODULE_PARSER],
  }
}
