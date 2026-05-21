import type { Config } from 'style-dictionary'

export interface VitePluginStyleDictionaryOptions {
  /**
   * Style Dictionary configuration(s).
   * Can be:
   * - A file path string (e.g. 'sd.config.json')
   * - An array of file path strings
   * - A Style Dictionary configuration object
   * - An array of Style Dictionary configuration objects
   * - A function that returns a config or array of configs (or resolves to them)
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
