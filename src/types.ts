import type { Config } from 'style-dictionary'

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
 * The three `onBuild*` hooks are called synchronously and their return value
 * is not awaited, so a build never waits for one. A hook may still be written
 * `async`: a promise it returns is left to run on its own, and a rejection is
 * caught and reported rather than reaching the host as an unhandled one. A
 * hook that throws is reported and does not fail the build that called it.
 *
 * They return `Promise<void> | void` rather than `void` for that reason. Both
 * accept an `async` hook as far as the compiler is concerned, but `void` alone
 * makes one a `no-misused-promises` error under the type-aware lint rules a
 * consumer is likely to be running — for a hook this documents as supported.
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
   * Called once a build has finished, with every file it declares and how long
   * it took in milliseconds.
   *
   * The paths are absolute and platform-native, sorted so two runs of the same
   * configuration hand back the same order. They are what the build declares
   * rather than what it wrote this time: a configuration skipped by `cache`
   * contributes its destinations too, because they are on disk and current,
   * and a post-processing step that ignored them would leave half the output
   * untouched on a rebuild that changed one file.
   *
   * This is where formatting the generated files, type-checking them, or
   * telling something else they have landed belongs.
   *
   * @default undefined
   */
  onBuildEnd?: (files: string[], durationMs: number) => Promise<void> | void

  /**
   * Called when a build fails, with whatever was thrown.
   *
   * It fires whatever `failOnError` is set to, and before that option decides
   * whether to rethrow — the two answer different questions, and under a dev
   * server the default is not to throw at all.
   *
   * The failure is reported to the console either way, so this is for reacting
   * to one rather than for noticing it.
   *
   * @default undefined
   */
  onBuildError?: (error: unknown) => Promise<void> | void

  /**
   * Called before a build begins, once per build.
   *
   * A watch-triggered rebuild is a build, so this fires again for each one.
   *
   * @default undefined
   */
  onBuildStart?: () => Promise<void> | void

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
