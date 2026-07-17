# unplugin-style-dictionary

A lightweight, robust [unplugin](https://unplugin.unjs.io/)-based plugin to compile **Style Dictionary** design tokens ahead of your bundler, with automatic watching, rebuilding, and hot reloading (HMR) under Vite's dev server.

Built on unplugin, the same core plugin targets **Vite**, **Rolldown**, **Rollup**, and **Webpack** from a single implementation — useful when a project has more than one build surface (e.g. Storybook/Vitest on Vite, and a package build on Rolldown/tsdown) that both need tokens compiled ahead of them.

## Features

- **Multi-bundler**: One implementation, four entry points — Vite, Rolldown, Rollup, and Webpack.
- **Asynchronous builds**: Native support for Style Dictionary v4/v5 async compilation API.
- **Automatic watching**: Reads the `source` and `include` patterns from your Style Dictionary configurations and automatically watches them. Live rebuild-on-change is fully supported under Vite's dev server; other targets rebuild on change wherever the host bundler itself runs a persistent watch mode.
- **Config flexibility**: Supports file paths (JSON, JS, MJS, CJS, TS), configuration objects, or functions — including registering custom formats at config-resolution time.
- **Multi-configuration**: Can run multiple Style Dictionary configurations in parallel (useful for multi-brand or multi-theme projects).
- **TypeScript Support**: Fully written in TypeScript and exports complete type definitions.

## Installation

```bash
npm install @kanso-labs/unplugin-style-dictionary style-dictionary --save-dev
```

*Note: `style-dictionary` and your bundler (`vite`, `rolldown`, `rollup`, or `webpack`) are peer dependencies, so you can manage their versions independently.*

## Usage

Import the entry point that matches your bundler.

### Vite

```typescript
import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    StyleDictionary({
      // Path to your Style Dictionary config file
      config: 'tokens/config/sd.config.json',
    }),
  ],
})
```

### Rolldown

```typescript
import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/rolldown'

export default {
  plugins: [
    StyleDictionary({
      config: 'tokens/config/sd.config.json',
    }),
  ],
}
```

Rolldown (and tools built on it, like [tsdown](https://tsdown.dev/)) is typically run as a one-shot build rather than a long-lived dev server, so under this target the plugin compiles tokens once in `buildStart` rather than watching for changes. That's enough to guarantee generated token files exist before the rest of the build consumes them.

### Rollup / Webpack

```typescript
import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/rollup'
// or: import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/webpack'
```

### Multiple Configurations

If you have multiple themes or sub-brands, pass an array of config paths or objects:

```typescript
StyleDictionary({
  config: [
    'tokens/config/sd-base.config.json',
    'tokens/config/sd-theme.config.json'
  ]
})
```

### Config Objects

You can pass Style Dictionary configuration objects directly:

```typescript
StyleDictionary({
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

### Custom Formats

`config` also accepts a function, which is the pattern to use when you need to register a custom Style Dictionary format (via `StyleDictionary.registerFormat()`, or any other `register*` call) before it's referenced by name in the returned config. The function re-runs on every build — including watch-triggered rebuilds under Vite — so the format is always registered before it's needed; re-registering the same format name on every rebuild is safe (Style Dictionary silently replaces the existing one).

```typescript
// Named `styleDictionaryPlugin` here to avoid colliding with the `StyleDictionary`
// class imported from the `style-dictionary` package itself, below.
import styleDictionaryPlugin from '@kanso-labs/unplugin-style-dictionary/vite'
import StyleDictionary from 'style-dictionary'

export default defineConfig({
  plugins: [
    styleDictionaryPlugin({
      config: () => {
        StyleDictionary.registerFormat({
          name: 'custom/my-format',
          format: ({ dictionary }) =>
            dictionary.allTokens
              .map((token) => `${token.name}: ${token.value}`)
              .join('\n'),
        })

        return {
          source: ['tokens/**/*.json'],
          platforms: {
            custom: {
              transformGroup: 'css',
              buildPath: 'dist/',
              files: [{ destination: 'tokens.txt', format: 'custom/my-format' }],
            },
          },
        }
      },
    }),
  ],
})
```

## Options Reference

```typescript
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

## Migrating from `vite-plugin-style-dictionary`

This package was previously published as `@kanso-labs/vite-plugin-style-dictionary`, implemented directly as a Vite plugin. As of this unplugin-based rewrite:

- The package is renamed to `@kanso-labs/unplugin-style-dictionary`.
- The root import no longer resolves to a ready-to-use Vite plugin. Import the bundler-specific entry point instead: `@kanso-labs/unplugin-style-dictionary/vite` (a drop-in replacement for the old default export), `/rolldown`, `/rollup`, or `/webpack`.
- The exported options type is renamed from `VitePluginStyleDictionaryOptions` to `UnpluginStyleDictionaryOptions`. The shape of the options (`config`, `watch`, `silent`) is unchanged.
- Behavior under Vite is unchanged: the same `buildStart`-time compilation and dev-server watch/rebuild logic as before.

## License

MIT
