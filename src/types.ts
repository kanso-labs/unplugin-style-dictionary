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
   * Disable console logging.
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
