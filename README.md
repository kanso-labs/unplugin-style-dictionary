# unplugin-style-dictionary

A lightweight, robust [unplugin](https://unplugin.unjs.io/)-based plugin to
compile **Style Dictionary** design tokens ahead of your bundler, with automatic
watching, rebuilding, and hot reloading (HMR) under Vite's dev server.

Built on unplugin, the same core plugin targets **Vite**, **Rolldown**,
**Rollup**, and **Webpack** from a single implementation — useful when a project
has more than one build surface (e.g. Storybook/Vitest on Vite, and a package
build on Rolldown/tsdown) that both need tokens compiled ahead of them.

## Features

- **Multi-bundler**: One implementation, four entry points — Vite, Rolldown,
  Rollup, and Webpack.
- **Asynchronous builds**: Native support for Style Dictionary v4/v5 async
  compilation API.
- **Automatic watching**: Reads the `source` and `include` patterns from your
  Style Dictionary configurations and watches the files they match. What a
  change then triggers depends on the target — see
  [Watching, per target](#watching-per-target).
- **Config flexibility**: Supports file paths (JSON, JSON5, JSONC, JS, MJS, TS),
  configuration objects, or functions — including registering custom formats at
  config-resolution time.
- **Atomic writes**: Every generated file is written to a temporary sibling and
  renamed into place, so code importing a token file while it is being rebuilt
  never reads a half-written file.
- **Multi-configuration**: Can run multiple Style Dictionary configurations in
  one build (useful for multi-brand or multi-theme projects). They are compiled
  one after another on purpose, so two configurations may safely write to the
  same destination; the platforms inside a single configuration are built
  concurrently by Style Dictionary itself.
- **TypeScript Support**: Fully written in TypeScript and exports complete type
  definitions.

## Installation

```bash
npm install @kanso-labs/unplugin-style-dictionary style-dictionary --save-dev
```

_Note: `style-dictionary` and your bundler (`vite`, `rolldown`, `rollup`, or
`webpack`) are peer dependencies, so you can manage their versions
independently._

**This package needs Node 22.12 or newer.** The floor is Style Dictionary v5's,
not this plugin's: every 5.x release declares `engines.node >= 22.0.0`, and it
is a required peer rather than an optional one, so an older Node cannot install
a working set at all. Node 20 reached end of life on 30 April 2026.

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

Rolldown (and tools built on it, like [tsdown](https://tsdown.dev/)) is
typically run as a one-shot build rather than a long-lived dev server. There the
plugin compiles tokens once in `buildStart`, which is enough to guarantee
generated token files exist before the rest of the build consumes them.

Under a real `rolldown.watch()`, do not rely on a token edit triggering a
rebuild — see [Watching, per target](#watching-per-target).

### Rollup / Webpack

```typescript
import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/rollup'
// or: import StyleDictionary from '@kanso-labs/unplugin-style-dictionary/webpack'
```

A `webpack.config.js` is often CommonJS rather than ESM. This package ships ESM
only, and Node serves a `require` of it through `require(esm)`, which hands back
the module namespace — so reach for `.default`:

```javascript
const {
  default: StyleDictionary,
} = require('@kanso-labs/unplugin-style-dictionary/webpack')

module.exports = {
  plugins: [StyleDictionary({ config: 'sd.config.json' })],
}
```

_Note: that path needs Node 20.19+ or 22.12+, the versions that can `require` an
ES module. Every Node release still in support clears it. Importing from ESM has
no such floor._

_The subpaths also need a TypeScript `moduleResolution` of `bundler`, `node16`
or `nodenext`. The deprecated `node10` cannot resolve them, and TypeScript 6
already warns that it stops working in 7._

### Config File Formats

A `config` path may be `.json`, `.json5`, `.jsonc`, `.js`, `.mjs` or `.ts`. The
JSON family is parsed as JSON5, so comments and trailing commas are accepted in
a `.json` file too — that is what Style Dictionary itself does, and the plugin
reads the file the same way so the watch list and the build never disagree about
what the configuration says.

Two limits worth knowing before you pick one:

- **A `.ts` config needs Node >= 22.18**, where type stripping is on by default.
  Below that the build fails with `Could not import TypeScript file`. That is
  higher than the package's own floor of 22.12, so it is a requirement of this
  one config format rather than of the plugin — and nothing warns at install
  time, because the package installs happily on 22.12.
- **`.cjs` is not supported.** Style Dictionary has no branch for that extension
  and parses it as JSON5, which fails on the first `module`. Rename the file to
  `.js` in a CommonJS package, or pass a configuration object.

### Multiple Configurations

If you have multiple themes or sub-brands, pass an array of config paths or
objects:

```typescript
StyleDictionary({
  config: [
    'tokens/config/sd-base.config.json',
    'tokens/config/sd-theme.config.json',
  ],
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
        files: [{ destination: 'variables.css', format: 'css/variables' }],
      },
    },
  },
})
```

### Custom Formats

`config` also accepts a function, which is the pattern to use when you need to
register a custom Style Dictionary format (via
`StyleDictionary.registerFormat()`, or any other `register*` call) before it's
referenced by name in the returned config. The function re-runs on every build —
including watch-triggered rebuilds under Vite — so the format is always
registered before it's needed; re-registering the same format name on every
rebuild is safe (Style Dictionary silently replaces the existing one).

It runs for builds and for nothing else. A file change that matches no token
source and no config file does not reach it, so a dev server editing unrelated
project files leaves it alone — treat it as the place to prepare a build, not as
a general file-change hook.

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
              files: [
                { destination: 'tokens.txt', format: 'custom/my-format' },
              ],
            },
          },
        }
      },
    }),
  ],
})
```

## Watching, per target

Every target compiles tokens before the build that consumes them. What a later
change to a token file triggers is not the same everywhere, because it depends
on what the host bundler does with the watch list the plugin registers.

| Target       | Compiles before the build | Rebuilds on a token change     | Safe from rebuild loops |
| ------------ | ------------------------- | ------------------------------ | ----------------------- |
| **Vite**     | yes                       | yes, under the dev server      | yes                     |
| **Rollup**   | yes                       | yes, under `rollup --watch`    | yes                     |
| **Webpack**  | yes                       | yes, under `webpack --watch`   | yes                     |
| **Rolldown** | yes                       | platform-dependent — see below | yes                     |

Patterns and literal paths behave the same way wherever rebuilds happen at all.
A `source` of `tokens/**/*.json` matches a file sitting directly in `tokens/` as
well as one in a subdirectory, and a file created after the watcher started is
picked up too.

**Rolldown is the exception, and it is not about globs.** `this.addWatchFile()`
is accepted by rolldown either way, and what happens next differs by platform:
on macOS a file registered through it is watched by nothing, so a token edit
reaches no hook, while on a Linux runner the same edit reaches a rebuild. Treat
rolldown's watch mode as compiling once and not tracking tokens, and reach for a
one-shot build or another target if you need rebuild-on-change.

"Safe from rebuild loops" is worth stating because consuming code imports the
generated file, so every regenerate is itself a change the host reacts to. The
plugin subtracts its own output from the watch list, skips recompiling when a
watch rebuild re-enters `buildStart`, and skips the write entirely when a
rebuild renders bytes identical to what is already on disk.

## One Compile per Process

A bundler instance that asks for a compile while an identical one is already
running waits for it rather than starting a second. Generated token files are a
side effect on the filesystem, not per-bundler output, so there is nothing to
gain from writing them twice.

This is not a rare case. One process often holds several instances of the
plugin: a single `vitest run` on a project with two test projects and browser
mode stands up five Vite servers — the root one, one per project, and one more
per project once its HTTP server listens — and every one of them runs
`buildStart`.

Two configurations are treated as the same compile only when they resolve to the
same root and the same configuration, functions included, so one script building
two packages shares nothing between them. The sharing lasts exactly as long as
the compile does: it stops two instances doing the same work at the same time,
and does not cache anything for later.

## Where Paths Are Resolved From

Two bases, and which one applies depends on whose path it is.

**The `config` option is the plugin's**, so a relative path is looked up under
the host's root: Vite's `root`, webpack's `context`, and the working directory
for rollup and rolldown, which report none. `root` overrides that.

**Everything inside a Style Dictionary configuration is Style Dictionary's**, so
`source`, `include` and `buildPath` are resolved against the working directory.
That is what Style Dictionary itself does — `combineJSON` globs each pattern
with no directory of its own — so a configuration behaves the same here as it
does under the Style Dictionary CLI.

The consequence worth knowing: a configuration kept in a subdirectory names its
tokens relative to where the build runs, not relative to itself.

```jsonc
// tokens/config/sd.config.json, with the build run from the project root
{
  // read from <project root>/tokens, not from tokens/config/tokens
  "source": ["tokens/**/*.json"],
}
```

Absolute paths sidestep the question entirely, and are worth reaching for when
the build might be run from more than one directory.

## Logging

Style Dictionary says useful things while it builds — a name collision, a
reference it could not resolve, `No tokens for vars.css. File not created.` —
and the plugin used to suppress all of it by overwriting `log.verbosity` on the
way past. It no longer touches that setting unless asked, so whatever your
configuration sets now reaches you.

`logLevel` overrides it from the plugin side:

```typescript
StyleDictionary({
  config: 'sd.config.json',
  // 'silent' | 'warn' | 'info' | 'verbose'. Unset leaves your config's own
  // log.verbosity alone, which is the default.
  logLevel: 'warn',
})
```

`'warn'` is the level worth knowing about: Style Dictionary's warnings without
the plugin's own progress lines and size table. `silent: true` is an alias for
`'silent'`.

A compile that fails is reported at every level, including `'silent'`, which is
why there is no `'error'`. `log.warnings` is never touched: if your
configuration turns a warning into a thrown build, that stays your decision.

## Failing the Build

A token compile that fails stops the build. `vite build`, `rollup` and `webpack`
exit non-zero with Style Dictionary's own message, rather than finishing green
and shipping whatever the previous run wrote.

A watch-triggered rebuild only reports the failure, so a dev server survives a
half-typed token file. `failOnError` moves that line:

```typescript
StyleDictionary({
  config: 'sd.config.json',
  // 'build' is the default. 'serve' fails rebuilds instead, true fails both,
  // false restores the old report-and-continue behaviour.
  failOnError: true,
})
```

A failure is always reported, whatever `failOnError` and `silent` are set to.

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
   * Whether a compile that fails should throw rather than only be reported.
   *
   * - 'build' (the default) throws on the one-shot compile in buildStart, and
   *   only reports a failed watch rebuild.
   * - 'serve' is the reverse: a failed rebuild is thrown to whatever awaited
   *   it. Vite's dev server has no build to fail, so there it is reported.
   * - true throws on both, false on neither.
   *
   * Reporting happens either way, and is not suppressed by 'silent'.
   *
   * @default 'build'
   */
  failOnError?: 'build' | 'serve' | boolean

  /**
   * The directory a relative config path is looked up in.
   *
   * Defaults to the host's own root — Vite's root, webpack's context — and to
   * the working directory for rollup and rolldown, which offer none. A
   * relative value here is resolved against the working directory, and it
   * takes precedence over whatever the host reports.
   *
   * It does not move the paths inside a configuration. See "Where paths are
   * resolved from" below.
   */
  root?: string

  /**
   * How much this plugin and Style Dictionary say while building.
   *
   * - 'silent' — nothing from either.
   * - 'warn' — Style Dictionary's warnings, and nothing from the plugin.
   * - 'info' — the above, plus the plugin's progress lines and size table.
   * - 'verbose' — the above, with Style Dictionary naming what it warned about.
   *
   * Leave it unset and the configuration's own log.verbosity stands.
   * A compile that fails is reported at every level.
   *
   * @default undefined
   */
  logLevel?: 'info' | 'silent' | 'verbose' | 'warn'

  /**
   * Disable console logging.
   *
   * An alias for logLevel: 'silent', which wins if both are set. A compile
   * that fails is always reported.
   *
   * @default false
   */
  silent?: boolean
}
```

## Migrating from `vite-plugin-style-dictionary`

This package was previously published as
`@kanso-labs/vite-plugin-style-dictionary`, implemented directly as a Vite
plugin. As of this unplugin-based rewrite:

- The package is renamed to `@kanso-labs/unplugin-style-dictionary`.
- The root import no longer resolves to a ready-to-use Vite plugin. Import the
  bundler-specific entry point instead:
  `@kanso-labs/unplugin-style-dictionary/vite` (a drop-in replacement for the
  old default export), `/rolldown`, `/rollup`, or `/webpack`.
- The exported options type is renamed from `VitePluginStyleDictionaryOptions`
  to `UnpluginStyleDictionaryOptions`. The shape of the options (`config`,
  `watch`, `silent`) is unchanged. It is exported from every entry point, so it
  comes from the same specifier as the plugin:
  `import type { UnpluginStyleDictionaryOptions } from '@kanso-labs/unplugin-style-dictionary/vite'`.
- Behavior under Vite is unchanged: the same `buildStart`-time compilation and
  dev-server watch/rebuild logic as before.

## License

MIT
