# vite-plugin-style-dictionary

A lightweight, robust Vite plugin to compile **Style Dictionary** design tokens with automatic watching, rebuilding, and hot reloading (HMR) during development.

## Features

- **Asynchronous builds**: Native support for Style Dictionary v4/v5 async compilation API.
- **Automatic watching**: Reads the `source` and `include` patterns from your Style Dictionary configurations and automatically watches them during development.
- **Config flexibility**: Supports file paths (JSON, JS, MJS, CJS, TS), configuration objects, or functions.
- **Multi-configuration**: Can run multiple Style Dictionary configurations in parallel (useful for multi-brand or multi-theme projects).
- **TypeScript Support**: Fully written in TypeScript and exports complete type definitions.

## Installation

```bash
npm install vite-plugin-style-dictionary style-dictionary --save-dev
```

*Note: `style-dictionary` and `vite` are peer dependencies, so you can manage their versions independently.*

## Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import { vitePluginStyleDictionary } from 'vite-plugin-style-dictionary'

export default defineConfig({
  plugins: [
    vitePluginStyleDictionary({
      // Path to your Style Dictionary config file
      config: 'tokens/config/sd.config.json',
    }),
  ],
})
```

### Multiple Configurations

If you have multiple themes or sub-brands, pass an array of config paths or objects:

```typescript
vitePluginStyleDictionary({
  config: [
    'tokens/config/sd-base.config.json',
    'tokens/config/sd-theme.config.json'
  ]
})
```

### Config Objects

You can pass Style Dictionary configuration objects directly:

```typescript
vitePluginStyleDictionary({
  config: {
    source: ['tokens/**/*.json'],
    platforms: {
      css: {
        transformGroup: 'css',
        buildPath: 'dist/css/',
        files: [{ destination: 'variables.css', format: 'css/variables' }]
      }
    }
  }
})
```

## Options Reference

```typescript
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
    | string
    | string[]
    | Config
    | Config[]
    | (() => Config | Config[] | Promise<Config | Config[]>)

  /**
   * Additional files or glob patterns to watch.
   * If config files are paths, those paths are watched automatically.
   * By default, the plugin also parses 'source' and 'include' properties in configurations and watches them.
   */
  watch?: string | string[]

  /**
   * Disable console logging.
   * @default false
   */
  silent?: boolean
}
```

## License

MIT
