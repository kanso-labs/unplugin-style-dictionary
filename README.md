# unplugin-style-dictionary

[![npm version][npm-version-shield]][npm]
[![npm downloads][npm-downloads-shield]][npm]
[![License][license-shield]][license] [![Build][build-shield]][build-workflow]
[![Test][test-shield]][test-workflow] [![Coverage][coverage-shield]][codecov]

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
- **Error overlay**: A rebuild that fails under Vite's dev server is pushed to
  the error overlay rather than only to the terminal, and cleared on the next
  one that succeeds.
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

## Skipping a Build That Would Change Nothing

A configuration whose output is already newer than everything it reads is not
compiled again. `buildAllPlatforms` is around 80% of a build, and under Vite it
runs inside `server.listen()` — so without this the dev server refused
connections for the length of a compile whether or not a token had changed.

Three things are compared: every file the configuration reads (its `source` and
`include` matches, its own config file, and anything named by `watch`), every
file it declares, and — for a configuration that is not a file — what the
configuration looked like when those files were written.

Two cases never skip, because neither can be settled from the filesystem:

| Case                                                                                 | Why                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The first compile of a process, for a configuration given as an object or a function | There is no config file to stat, so an edit to the object inside `vite.config.ts` moves no mtime. Within one process the resolved configuration is compared against the one last built; across processes there is nothing to compare. |
| A platform declaring `actions`                                                       | An action writes what no `destination` names, so a skip would leave its work undone.                                                                                                                                                  |

A custom format that reads something off-disk — an environment variable, a
network call — cannot be detected this way either. Set `cache: false` where that
is the case, and every build runs.

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

Under Vite's dev server it is reported to the browser as well. A failed rebuild
is pushed to Vite's error overlay, naming this plugin and carrying Style
Dictionary's message, and the overlay is dismissed by the next rebuild that
succeeds — so a page left rendering the last good token file says so instead of
looking current. Set `errorOverlay: false` to keep the failure in the terminal
only.

`failOnError` and `errorOverlay` answer different questions and do not interact:
the first decides whether the host stops, the second whether the browser is
told. The dev server's default is not to stop, which is exactly when the overlay
is the only thing that can report the failure.

## Public API

Small on purpose. Four bundler entry points, one root entry, and one type.

| Import                                          | What it is                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `…/vite`, `…/rolldown`, `…/rollup`, `…/webpack` | Default export: the plugin for that bundler. Call it with the options below.                                           |
| `…` (the root)                                  | Default export, also named `unplugin`: the unplugin instance, carrying `.vite`, `.rolldown`, `.rollup` and `.webpack`. |
| `UnpluginStyleDictionaryOptions`                | The options type, exported from every entry above.                                                                     |

Anything not in that table is internal, whatever a build output happens to
contain. In particular the watch filter and the raw unplugin factory are not
exported: the filter answers a question only this plugin asks, and the factory
takes a second `meta` argument — the bundler-identifying `UnpluginContextMeta` —
that a consumer would have to construct by hand, so calling it the obvious way
is a type error rather than a plugin.

Reach for the root entry when you need a target that has no subpath of its own,
or when one configuration object feeds more than one bundler:

```typescript
import styleDictionary from '@kanso-labs/unplugin-style-dictionary'

const plugin = styleDictionary.rollup({ config: 'sd.config.json' })
```

## Options Reference

```typescript
/**
 * Options for the Style Dictionary unplugin factory, shared across all bundler
 * targets (Vite, Rolldown, Rollup, Webpack).
 *
 * Every target compiles tokens before the build that consumes them. Live
 * rebuild-on-change is driven by the host bundler's watch mode, because token
 * source files sit outside the module graph: Vite's dev server, `rollup
 * --watch` and `webpack --watch` all rebuild on a token change, and a one-shot
 * build (e.g. `tsdown`/`rolldown build` without `--watch`) only builds once, in
 * `buildStart`.
 *
 * Rolldown's watch mode is the exception, and it is not about glob patterns.
 * `addWatchFile` is accepted either way, but what happens next differs by
 * platform — on macOS a file registered through it is watched by nothing, while
 * on a Linux runner the same edit reaches a rebuild. Do not rely on a token
 * edit triggering a rebuild there.
 */
export interface UnpluginStyleDictionaryOptions {
  /**
   * Whether a configuration whose output is already up to date may skip its
   * compile.
   *
   * A build's expensive half is `buildAllPlatforms` — around 80% of it on a
   * 4,000-token, two-platform configuration — and under Vite it runs inside
   * `server.listen()`, so the dev server does not accept a connection until
   * it finishes whether or not a token changed. A configuration is treated as
   * up to date when every file it declares exists and is newer than every
   * file it reads, its own config file included.
   *
   * Two things are never skipped, because neither can be told from the
   * filesystem:
   *
   * - **The first compile of a process, for a configuration given as an
   *   object or a function.** There is no config file to stat, so an edit to
   *   the object inside `vite.config.ts` moves no mtime. Within one process
   *   the resolved configuration is compared against the one that was last
   *   built; across processes there is nothing to compare, so it builds.
   * - **A platform declaring `actions`.** An action writes what no
   *   `destination` names, so a skip would leave its work undone.
   *
   * A custom format that reads something off-disk — an environment variable,
   * a network call — cannot be detected this way either, and is what this
   * option exists to turn off.
   *
   * @default true
   */
  cache?: boolean

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
   * If not provided, the root directory is searched for 'sd.config.json',
   * 'config.json', 'sd.config.js' and 'sd.config.mjs', in that order. The
   * first one that exists wins, and the rest are not looked at.
   */
  config?:
    | (() => Config | Config[] | Promise<Config | Config[]>)
    | Config
    | Config[]
    | string
    | string[]

  /**
   * Whether a failed rebuild is pushed to Vite's error overlay.
   *
   * A rebuild that fails under the dev server used to reach the browser
   * nowhere: the page went on rendering the last good generated file, and the
   * only trace was one red terminal line the developer may not have been
   * looking at. With this on, the failure is sent to the page as an error
   * frame naming this plugin, and the overlay is dismissed on the next
   * rebuild that succeeds.
   *
   * This is Vite's overlay, so it does nothing on the other three targets,
   * and nothing under `vite build` — there is no page to draw on.
   *
   * It is not `failOnError`'s job, and the two are independent. `failOnError`
   * decides whether the host stops; this decides whether the browser is told.
   * A dev server deliberately keeps serving through a failed rebuild, which is
   * precisely the case where the overlay is the only thing that can say so.
   *
   * A failure Style Dictionary raises before this plugin can catch it — a
   * token file that is not valid JSON, which rejects out of band — reaches
   * neither the overlay nor this option.
   *
   * @default true
   */
  errorOverlay?: boolean

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
   * Whether the table of generated files and their sizes is produced.
   *
   * Every generated file is read in full and gzipped at level 6 to fill the
   * `gzip:` column — 4.5ms for 515kB of output, and 21ms at 6MB. That is
   * small beside the compile it follows, and it is pure cost to a project
   * large enough to care.
   *
   * This is not `logLevel`'s job, and the two differ in what they leave
   * standing. `logLevel: 'warn'` silences the plugin's progress lines along
   * with the table; `report: false` keeps them and drops only the table,
   * along with the read and the compression behind it.
   *
   * Dropping to gzip level 1 instead was measured and rejected: it reported a
   * figure up to 8.7% off — 21.4kB against 19.7kB on the same JSON — and that
   * number is one a consumer compares against their own bundler's report.
   *
   * @default true
   */
  report?: boolean

  /**
   * The directory a relative `config` path is looked up in.
   *
   * Defaults to the host's own root — Vite's `root`, webpack's `context` —
   * and to the working directory for rollup and rolldown, which offer none.
   * A relative value here is resolved against the working directory, and it
   * takes precedence over whatever the host reports.
   *
   * It does not move the paths **inside** a configuration. Style Dictionary
   * resolves every relative `source`, `include` and `buildPath` against the
   * working directory, and this plugin reads them the same way, so a
   * configuration behaves identically here and under Style Dictionary's own
   * CLI. A configuration kept in a subdirectory therefore names its tokens
   * relative to where the build runs, not relative to itself.
   */
  root?: string

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
   * Additional files or glob patterns to watch, on top of what is watched
   * already: a `config` given as a path, and every file matched by the
   * `source` and `include` patterns inside each configuration.
   *
   * Patterns are expanded to the paths they match before being registered,
   * because the watchers in play take filenames rather than patterns. A
   * pattern's own directory is registered alongside them, so a token file
   * created later is noticed too.
   *
   * What a change to a watched file then triggers is the host's to decide —
   * see the interface documentation above.
   */
  watch?: string | string[]
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

[build-shield]:
  https://img.shields.io/github/actions/workflow/status/kanso-labs/unplugin-style-dictionary/build.yaml?branch=main&label=Build
[build-workflow]:
  https://github.com/kanso-labs/unplugin-style-dictionary/actions/workflows/build.yaml
[codecov]: https://codecov.io/gh/kanso-labs/unplugin-style-dictionary
[coverage-shield]:
  https://img.shields.io/codecov/c/github/kanso-labs/unplugin-style-dictionary?label=Coverage
[license]: ./LICENSE
[license-shield]:
  https://img.shields.io/github/license/kanso-labs/unplugin-style-dictionary
[npm]: https://www.npmjs.com/package/@kanso-labs/unplugin-style-dictionary
[npm-downloads-shield]:
  https://img.shields.io/npm/dm/@kanso-labs/unplugin-style-dictionary
[npm-version-shield]:
  https://img.shields.io/npm/v/@kanso-labs/unplugin-style-dictionary
[test-shield]:
  https://img.shields.io/github/actions/workflow/status/kanso-labs/unplugin-style-dictionary/test.yaml?branch=main&label=Test
[test-workflow]:
  https://github.com/kanso-labs/unplugin-style-dictionary/actions/workflows/test.yaml
