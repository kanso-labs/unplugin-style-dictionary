import type { Config } from 'style-dictionary'

/**
 * Options for the Style Dictionary unplugin factory, shared across all bundler
 * targets (Vite, Rolldown, Rollup, Webpack).
 *
 * Live rebuild-on-change is driven by the host bundler's watch mode. Vite's dev
 * server is handled explicitly and is the best-supported case. Other targets
 * rebuild on change only when the host bundler itself runs a persistent watch
 * mode (e.g. `rollup --watch`), since token source files sit outside the module
 * graph. A one-shot build (e.g. `tsdown`/`rolldown build` without `--watch`)
 * only builds once, in `buildStart`.
 */
export interface UnpluginStyleDictionaryOptions {
  /**
   * Style Dictionary configuration(s).
   * Can be:
   * - A file path string (e.g. 'sd.config.json')
   * - An array of file path strings
   * - A Style Dictionary configuration object
   * - An array of Style Dictionary configuration objects
   * - A function that returns a config or array of configs (or resolves to them).
   *   Useful for calling `StyleDictionary.registerFormat()` (or other `register*`
   *   methods) before returning a config that references the custom format by name.
   *
   * If not provided, it will look for 'sd.config.json' or 'config.json' in the root directory.
   */
  config?:
    | (() => Config | Config[] | Promise<Config | Config[]>)
    | Config
    | Config[]
    | string
    | string[]

  /**
   * Whether a compile that fails should throw rather than only be reported.
   *
   * A failed compile used to be logged and swallowed, so `vite build`,
   * `rollup` and `webpack` all exited 0 and shipped whatever the previous
   * run had written — the stale values, presented as current.
   *
   * - `'build'` (the default) throws on the one-shot compile that runs in
   *   `buildStart`, and only reports a failed watch rebuild, so a dev server
   *   survives a half-typed token file.
   * - `'serve'` is the reverse: a failed rebuild is thrown to whatever awaited
   *   it, which is the host under `rollup --watch`. Vite's dev server has no
   *   build to fail, so there it is reported and the server keeps serving.
   * - `true` throws on both, `false` on neither.
   *
   * Reporting happens either way, and is not suppressed by `silent`.
   *
   * @default 'build'
   */
  failOnError?: 'build' | 'serve' | boolean

  /**
   * How much this plugin and Style Dictionary say while building.
   *
   * Style Dictionary's own warnings — a name collision, a reference that
   * cannot be resolved, `No tokens for vars.css. File not created.` — used to
   * be suppressed unconditionally, because the plugin overwrote
   * `log.verbosity` on the way past. Leave this unset and whatever the
   * configuration asked for stands.
   *
   * - `'silent'` — nothing from either.
   * - `'warn'` — Style Dictionary's warnings, and nothing from the plugin.
   * - `'info'` — the above, plus the plugin's progress lines and size table.
   * - `'verbose'` — the above, with Style Dictionary naming what it warned
   *   about rather than pointing at its own `--verbose` flag.
   *
   * A compile that fails is reported at every level, so there is no
   * `'error'`: `'silent'` is the quietest and still reports a failure.
   *
   * @default undefined, which prints the plugin's own lines and leaves the
   * configuration's `log.verbosity` alone
   */
  logLevel?: 'info' | 'silent' | 'verbose' | 'warn'

  /**
   * Disable console logging.
   *
   * An alias for `logLevel: 'silent'`, which wins if both are set. A compile
   * that fails is always reported.
   *
   * @default false
   */
  silent?: boolean

  /**
   * Additional files or glob patterns to watch.
   * If config files are paths, those paths are watched automatically.
   * By default, the plugin also parses 'source' and 'include' properties in configurations and watches them.
   */
  watch?: string | string[]
}
