import { unplugin } from './index.js'

// Re-exported here as well as from the root, so a consumer who imports the
// entry point for their bundler can name the options type from the same
// specifier. Without it the built `.d.ts` imports the type for its own
// signature and exports nothing but the plugin, and
// `import type { UnpluginStyleDictionaryOptions } from '.../rspack'` is a
// TS2614.
export type * from './types.js'

export default unplugin.rspack
