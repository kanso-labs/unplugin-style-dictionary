import type { Stats as RspackStats } from '@rspack/core'

import { rspack } from '@rspack/core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as rolldown from 'rolldown'
import * as rollup from 'rollup'
import * as vite from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import webpack from 'webpack'

import rolldownPlugin from '../src/rolldown.ts'
import rollupPlugin from '../src/rollup.ts'
import rspackPlugin from '../src/rspack.ts'
import vitePlugin from '../src/vite.ts'
import webpackPlugin from '../src/webpack.ts'

// Every other test file drives one target. This one drives all four, because
// the claim that a fix in `src/index.ts` "reaches all four targets at once" is
// about the adapter wiring rather than about the shared code — and nothing
// checked that the wiring survives an `unplugin` bump. The concrete risk is a
// pinned bump that changes webpack's `make` wiring and lands with `Build`,
// `Lint` and `Test` all green.
//
// All four bundlers are pinned devDependencies here rather than optional
// peers, so an import that fails is a broken install and should fail loudly.

const posix = (value: string) => value.replace(/\\/g, '/')

const settle = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const waitUntil = async (satisfied: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await settle(50)
}

// Whether a rebuild counter stops moving, and what it stopped at. A fixed wait
// would be the wrong shape for this: the claim is that the rebuilds converge,
// and a loaded machine should make this test longer rather than red. Returns
// `null` when the count never went quiet, which is the runaway.
const settledCount = async (
  read: () => number,
  quietMs: number,
  timeoutMs: number,
): Promise<null | number> => {
  const deadline = Date.now() + timeoutMs
  let last = read()
  let quietSince = Date.now()

  while (Date.now() < deadline) {
    await settle(100)
    const current = read()

    if (current === last) {
      if (Date.now() - quietSince >= quietMs) return current
    } else {
      last = current
      quietSince = Date.now()
    }
  }

  return null
}

// The token source is a `**` glob rather than a literal path, which is the
// shape a real project writes and the one an unexpanded pattern is invisible
// in: every watcher in play treats a pattern as a filename that does not
// exist, so a glob registered rather than expanded watches nothing at all.
const writeFixture = (
  directory: string,
  { config, value = '#0070f3' }: { config?: string; value?: string } = {},
) => {
  const tokensDirectory = path.join(directory, 'tokens', 'nested')
  fs.mkdirSync(tokensDirectory, { recursive: true })
  fs.mkdirSync(path.join(directory, 'generated'), { recursive: true })

  const tokenSource = path.join(tokensDirectory, 'color.json')
  fs.writeFileSync(tokenSource, JSON.stringify({ color: { brand: { value } } }))

  const configFile = path.join(directory, 'sd.config.json')
  fs.writeFileSync(
    configFile,
    config ??
      JSON.stringify({
        platforms: {
          js: {
            buildPath: posix(path.join(directory, 'generated')) + '/',
            files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [posix(path.join(directory, 'tokens')) + '/**/*.json'],
      }),
  )

  // The entry re-exports a token rather than importing for side effects, so
  // the generated module cannot be tree-shaken out and the bundle assertions
  // are about what a consumer would actually receive.
  fs.writeFileSync(
    path.join(directory, 'entry.js'),
    [
      "import { ColorBrand } from './generated/tokens.js'",
      'export const brand = ColorBrand',
      '',
    ].join('\n'),
  )

  return {
    configFile,
    entry: path.join(directory, 'entry.js'),
    generated: path.join(directory, 'generated', 'tokens.js'),
    tokenSource,
  }
}

// Where each host puts a message the plugin reports. The plugin routes through
// the bundler now rather than writing to the console, so a `console.error` spy
// sees nothing on three of these four — the collector is what replaces it, and
// it is per target because no two hosts carry a plugin's message the same way.
type MessageSink = (message: string) => void

// One entry per target: how to run a single build of `directory` and hand back
// whatever the bundler emitted, so the assertions below can be written once.
// `onMessage` receives whatever the host was told, and is optional so the
// build assertions that do not care can leave it out.
const TARGETS = [
  {
    build: async (
      directory: string,
      configFile: string,
      onMessage?: MessageSink,
    ) => {
      const bundle = await rollup.rollup({
        input: path.join(directory, 'entry.js'),
        onwarn: (warning) => {
          onMessage?.(warning.message)
        },
        plugins: [rollupPlugin({ config: configFile, silent: true })],
      })
      const { output } = await bundle.generate({ format: 'es' })
      await bundle.close()

      return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('')
    },
    name: 'rollup',
  },
  {
    build: async (
      directory: string,
      configFile: string,
      onMessage?: MessageSink,
    ) => {
      const bundle = await rolldown.rolldown({
        input: path.join(directory, 'entry.js'),
        // `onLog` rather than the `onwarn` its sibling above uses: rolldown
        // deprecated that one, and the linter is type-aware enough to say so.
        onLog: (_level, log) => {
          onMessage?.(log.message)
        },
        plugins: [rolldownPlugin({ config: configFile, silent: true })],
      })
      const { output } = await bundle.generate({ format: 'es' })
      await bundle.close()

      return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('')
    },
    name: 'rolldown',
  },
  {
    // rspack's Node API is webpack's, so this is the webpack case with one
    // import changed — which is the claim worth pinning. unplugin dispatches
    // the two through separate plugin keys, so the entry point being new is
    // not the only thing that could be missing: without an `rspack` key the
    // compiler is never adopted, and the compile falls back to `buildStart`
    // inside `make`, where the module graph is already being resolved.
    build: async (
      directory: string,
      configFile: string,
      onMessage?: MessageSink,
    ) => {
      const stats = await new Promise<RspackStats | undefined>(
        (resolve, reject) => {
          rspack(
            {
              context: directory,
              entry: './entry.js',
              mode: 'development',
              output: { path: path.join(directory, 'dist') },
              plugins: [rspackPlugin({ config: configFile, silent: true })],
            },
            (error, result) => {
              if (error) reject(error)
              else resolve(result)
            },
          )
        },
      )

      const json = stats?.toJson({ all: true })
      for (const warning of json?.warnings ?? []) {
        onMessage?.(warning.message)
      }

      const errors = json?.errors ?? []
      if (errors.length > 0) throw new Error(errors[0]?.message ?? 'unknown')

      return fs.readFileSync(path.join(directory, 'dist', 'main.js'), 'utf-8')
    },
    name: 'rspack',
  },
  {
    build: async (
      directory: string,
      configFile: string,
      onMessage?: MessageSink,
    ) => {
      const record = (message: string) => onMessage?.(message)

      await vite.build({
        build: {
          lib: {
            entry: path.join(directory, 'entry.js'),
            fileName: 'out',
            formats: ['es'],
          },
          outDir: path.join(directory, 'dist'),
        },
        configFile: false,
        customLogger: {
          clearScreen: () => {},
          error: record,
          hasErrorLogged: () => false,
          hasWarned: false,
          info: record,
          warn: record,
          warnOnce: record,
        },
        logLevel: 'silent',
        plugins: [vitePlugin({ config: configFile, silent: true })],
        root: directory,
      })

      return fs.readFileSync(path.join(directory, 'dist', 'out.mjs'), 'utf-8')
    },
    name: 'vite',
  },
  {
    build: async (
      directory: string,
      configFile: string,
      onMessage?: MessageSink,
    ) => {
      const stats = await new Promise<undefined | webpack.Stats>(
        (resolve, reject) => {
          webpack(
            {
              context: directory,
              entry: './entry.js',
              mode: 'development',
              output: { path: path.join(directory, 'dist') },
              plugins: [webpackPlugin({ config: configFile, silent: true })],
            },
            (error, result) => {
              if (error) reject(error)
              else resolve(result)
            },
          )
        },
      )

      // `stats` is where a webpack plugin's message belongs, and reading it
      // here is what proves the plugin's report got there rather than onto a
      // console nothing in CI reads.
      const json = stats?.toJson({ all: true })
      for (const warning of json?.warnings ?? []) {
        onMessage?.(warning.message)
      }

      const errors = json?.errors ?? []
      if (errors.length > 0) throw new Error(errors[0]?.message ?? 'unknown')

      return fs.readFileSync(path.join(directory, 'dist', 'main.js'), 'utf-8')
    },
    name: 'webpack',
  },
]

describe('every target compiles tokens through its own bundler', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-targets-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it.each(TARGETS)(
    'writes the tokens and bundles them under $name',
    async ({ build, name }) => {
      const directory = path.join(tempDir, `build-${name}`)
      const { configFile, generated } = writeFixture(directory)

      const bundle = await build(directory, configFile)

      // Two separate claims. The tokens reached disk, and the bundle the host
      // produced carries them — which is the half a stubbed plugin context
      // can never see, since it never asks a bundler to resolve anything.
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#0070f3')
      expect(bundle).toContain('#0070f3')
    },
    60000,
  )

  it.each(TARGETS)(
    'fails rather than hanging on a config it cannot load under $name',
    async ({ build, name }) => {
      const directory = path.join(tempDir, `broken-${name}`)
      const { configFile } = writeFixture(directory, {
        config: '{ "platforms": {',
      })

      // Two places a message can land, and the assertion accepts either.
      // Three of the four hosts take the report on their own channel now; the
      // console is what is left where a host has none to offer, and on webpack
      // where a `run` that throws ends the run before a compilation ever
      // exists to attach it to.
      const messages: string[] = []
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation((...call: unknown[]) => {
          messages.push(String(call[0]))
        })

      try {
        // Settling at all is half the assertion — a configuration that
        // rejects a promise nobody holds is what used to leave a host
        // building forever — and rejecting is the other half, since a broken
        // token set must not pass for a successful build on any target.
        await expect(
          build(directory, configFile, (message) => messages.push(message)),
        ).rejects.toThrow(/JSON5|invalid|Failed to load/i)

        // Capturing it is not the same as dropping it: the report is part of
        // what this asserts, since a failure the host stops for must also say
        // why.
        expect(
          messages.some((message) =>
            message.includes('Compilation failed after'),
          ),
        ).toBe(true)
      } finally {
        errorSpy.mockRestore()
      }
    },
    60000,
  )
})

// Rollup's watcher is pinned in `tests/index.test.ts`, and Vite's dev server
// has an item of its own, so the two here are the ones nothing was watching.
describe('every watching target rebuilds once and then settles', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-targets-watch-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // A token edit, and then an edit to a file in rolldown's own module graph,
  // each rebuilds and then stops. The generated file is in that graph too,
  // which is the shape a rebuild loop closes through.
  it('under a real rolldown watcher', async () => {
    const directory = path.join(tempDir, 'rolldown')
    const { configFile, entry, generated, tokenSource } =
      writeFixture(directory)

    let bundles = 0
    const watcher = rolldown.watch({
      input: entry,
      output: { dir: path.join(directory, 'dist'), format: 'es' },
      plugins: [rolldownPlugin({ config: configFile, silent: true })],
    })

    watcher.on('event', (event) => {
      if (event.code === 'BUNDLE_END') bundles += 1
    })

    try {
      await waitUntil(
        () =>
          bundles > 0 &&
          fs.existsSync(generated) &&
          fs.readFileSync(generated, 'utf-8').includes('#0070f3'),
        20000,
      )
      expect(bundles).toBeGreaterThan(0)

      // The watcher reports nothing for a moment after it is built, and an
      // edit landing inside that window is missed by the watcher rather than
      // by the plugin.
      await settle(500)

      // On macOS this fixture's path runs through `/var`, a symbolic link, so
      // the edit reaches rolldown only through the realpath the plugin
      // registers beside it. That is why this used to read as inert on macOS
      // and delivered on Linux — see AGENTS.md.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )

      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#ff0000'),
        20000,
      )
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#ff0000')

      // Settled before the entry edit, so the count it is measured against
      // is not still climbing from this one.
      expect(await settledCount(() => bundles, 1500, 20000)).not.toBeNull()

      // An edit rolldown certainly sees, because the entry is in its module
      // graph. Every rebuild re-enters `buildStart`, and a `buildStart` that
      // compiles would write the generated file, which is itself a
      // module-graph change — the loop that ran at about ten bundles a second,
      // forever.
      fs.writeFileSync(
        entry,
        [
          "import { ColorBrand } from './generated/tokens.js'",
          'export const brand = ColorBrand',
          'export const version = 2',
          '',
        ].join('\n'),
      )

      const beforeEntryEdit = bundles
      await waitUntil(() => bundles > beforeEntryEdit, 20000)
      expect(bundles).toBeGreaterThan(beforeEntryEdit)

      expect(await settledCount(() => bundles, 1500, 20000)).not.toBeNull()
    } finally {
      await watcher.close()
    }
  }, 60000)

  it('under a real webpack watcher', async () => {
    const directory = path.join(tempDir, 'webpack')
    const { configFile, generated, tokenSource } = writeFixture(directory)

    let builds = 0
    const compiler = webpack({
      context: directory,
      entry: './entry.js',
      mode: 'development',
      output: { path: path.join(directory, 'dist') },
      plugins: [webpackPlugin({ config: configFile, silent: true })],
    })

    const errors: string[] = []
    const watching = compiler.watch(
      { aggregateTimeout: 50 },
      (error, stats) => {
        if (error) errors.push(error.message)
        for (const reported of stats?.toJson().errors ?? []) {
          errors.push(reported.message)
        }
        builds += 1
      },
    )

    try {
      await waitUntil(() => builds > 0, 20000)
      expect(errors).toEqual([])

      await settle(500)

      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )

      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#ff0000'),
        20000,
      )
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#ff0000')

      expect(await settledCount(() => builds, 1500, 20000)).not.toBeNull()
      expect(errors).toEqual([])
    } finally {
      // `compiler.watch` is typed as possibly returning nothing, so closing it
      // is conditional rather than asserted — a watcher that was never created
      // has nothing to close, and claiming otherwise would be a cast.
      await new Promise<void>((resolve) => {
        if (!watching) {
          resolve()
          return
        }

        watching.close(() => {
          resolve()
        })
      })
    }
  }, 60000)
})

// Closes a watcher either host returned. Both type `watch()` as possibly
// returning nothing, so closing is conditional rather than asserted.
const closeWatching = async (
  watching: undefined | { close: (done: () => void) => void },
) =>
  new Promise<void>((resolve) => {
    if (!watching) {
      resolve()
      return
    }

    watching.close(() => {
      resolve()
    })
  })

// A token file created after the first build, under a glob `source`. The glob's
// static parent directory is registered so that such a file is noticed, and on
// webpack and rspack it used to go to `fileDependencies`, where a directory
// reports no new entry: nothing rebuilt until an existing token was edited.
describe.each([
  {
    name: 'webpack',
    watch: (
      directory: string,
      options: Parameters<typeof webpackPlugin>[0],
      onBuild: () => void,
    ) =>
      webpack({
        context: directory,
        entry: './entry.js',
        mode: 'development',
        output: { path: path.join(directory, 'dist') },
        plugins: [webpackPlugin(options)],
      }).watch({ aggregateTimeout: 50 }, onBuild),
  },
  {
    name: 'rspack',
    watch: (
      directory: string,
      options: Parameters<typeof rspackPlugin>[0],
      onBuild: () => void,
    ) =>
      rspack({
        context: directory,
        entry: './entry.js',
        mode: 'development',
        output: { path: path.join(directory, 'dist') },
        plugins: [rspackPlugin(options)],
      }).watch({ aggregateTimeout: 50 }, onBuild),
  },
])('a new token file under a real $name watcher', ({ name, watch }) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `unplugin-style-dictionary-new-file-${name}-`),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('rebuilds for a new top-level file and a new nested one', async () => {
    const directory = path.join(tempDir, 'glob')
    const { configFile, generated } = writeFixture(directory)
    const tokens = path.join(directory, 'tokens')

    let builds = 0
    const watching = watch(
      directory,
      { cache: false, config: configFile, silent: true },
      () => {
        builds += 1
      },
    )

    try {
      await waitUntil(() => builds > 0, 20000)
      await settledCount(() => builds, 1000, 20000)

      const beforeTopLevel = builds
      fs.writeFileSync(
        path.join(tokens, 'accent.json'),
        JSON.stringify({ color: { accent: { value: '#aa0000' } } }),
      )
      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#aa0000'),
        20000,
      )
      expect(builds).toBeGreaterThan(beforeTopLevel)
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#aa0000')
      await settledCount(() => builds, 1000, 20000)

      const beforeNested = builds
      fs.writeFileSync(
        path.join(tokens, 'nested', 'extra.json'),
        JSON.stringify({ color: { extra: { value: '#bb0000' } } }),
      )
      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#bb0000'),
        20000,
      )
      expect(builds).toBeGreaterThan(beforeNested)
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#bb0000')

      expect(await settledCount(() => builds, 1500, 20000)).not.toBeNull()
    } finally {
      await closeWatching(watching)
    }
  }, 60000)

  it('settles with the buildPath inside the source directory', async () => {
    // Every entry the plugin writes under a watched directory is now a change
    // to that directory, which counts as a token source changing — so its
    // own output reaches a compile. What ends that chain is the rebuild
    // rendering identical bytes and writing nothing.
    const directory = path.join(tempDir, 'inside')
    const tokens = path.join(directory, 'tokens')
    fs.mkdirSync(path.join(tokens, 'nested'), { recursive: true })
    fs.writeFileSync(
      path.join(tokens, 'nested', 'color.json'),
      JSON.stringify({ color: { brand: { value: '#0070f3' } } }),
    )

    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          js: {
            buildPath: posix(path.join(tokens, 'build')) + '/',
            files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [posix(tokens) + '/**/*.json'],
      }),
    )
    fs.writeFileSync(
      path.join(directory, 'entry.js'),
      [
        "import { ColorBrand } from './tokens/build/tokens.js'",
        'export const brand = ColorBrand',
        '',
      ].join('\n'),
    )
    const generated = path.join(tokens, 'build', 'tokens.js')

    let builds = 0
    const watching = watch(
      directory,
      { cache: false, config: configFile, silent: true },
      () => {
        builds += 1
      },
    )

    try {
      await waitUntil(() => builds > 0, 20000)
      await settledCount(() => builds, 1000, 20000)

      fs.writeFileSync(
        path.join(tokens, 'accent.json'),
        JSON.stringify({ color: { accent: { value: '#aa0000' } } }),
      )
      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#aa0000'),
        20000,
      )
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#aa0000')

      expect(await settledCount(() => builds, 1500, 20000)).not.toBeNull()
    } finally {
      await closeWatching(watching)
    }
  }, 60000)
})

describe('vite build --watch', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-build-watch-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('un-ignores a token package resolved through node_modules', async () => {
    // Vite 6 and 7 run `vite build --watch` on rollup's watcher, whose chokidar
    // ignore list always starts with `**/node_modules/**`, so a workspace token
    // package built once and never rebuilt. The dev server's fix never reached
    // this mode. The suite runs Vite 8, whose build watcher is rolldown's and
    // takes nothing from `chokidar`, so this asks the hook what it wrote rather
    // than watching; the rebuild itself was checked by hand on 6.4.3 and 7.3.6.
    const base = path.join(tempDir, 'workspace')
    const app = path.join(base, 'app')
    const pkg = path.join(base, 'packages', 'tokens')
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
    fs.mkdirSync(path.join(app, 'node_modules', '@acme'), { recursive: true })
    fs.writeFileSync(
      path.join(pkg, 'src', 'color.json'),
      JSON.stringify({ color: { brand: { value: '#111111' } } }),
    )
    fs.symlinkSync(
      pkg,
      path.join(app, 'node_modules', '@acme', 'tokens'),
      'dir',
    )

    const viaNodeModules = posix(
      path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json'),
    )

    // A consumer's own entry, which the negation goes after rather than
    // replacing. Vite 8 types `build.watch` as rolldown's options, which have
    // no `chokidar`, hence the variable rather than an inline literal.
    const watch = {
      buildDelay: 0,
      chokidar: { ignored: ['**/consumer-entry/**'] },
    }

    let toldWatch: boolean | undefined
    const resolved = await vite.resolveConfig(
      {
        build: { watch },
        configFile: false,
        logLevel: 'silent',
        plugins: [
          vitePlugin({
            config: (context) => {
              toldWatch = context.watch
              return {
                platforms: {
                  css: {
                    buildPath: posix(path.join(app, 'generated')) + '/',
                    files: [
                      { destination: 'vars.css', format: 'css/variables' },
                    ],
                    transformGroup: 'css',
                  },
                },
                source: [viaNodeModules],
              }
            },
            logLevel: 'silent',
          }),
        ],
        root: app,
      },
      'build',
    )

    const chokidar: unknown = Reflect.get(
      resolved.build.watch ?? {},
      'chokidar',
    )
    const ignored: unknown =
      typeof chokidar === 'object' && chokidar !== null
        ? Reflect.get(chokidar, 'ignored')
        : undefined

    expect(ignored).toEqual(['**/consumer-entry/**', `!${viaNodeModules}`])
    expect(toldWatch).toBe(true)
  })
})

describe('a token package linked into node_modules', () => {
  // Resolved, because on macOS `os.tmpdir()` is itself reached through a
  // symlink, and the link under test has to be the only one on the path.
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'unplugin-style-dictionary-linked-')),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('rebuilds on an edit under a real rolldown watcher', async () => {
    // The workspace shape: the token package lives in `packages/` and is
    // linked into the app's `node_modules`. The plugin registered each path
    // only as its pattern spells it, through the link, and on macOS rolldown's
    // watcher reports nothing for a path that runs through a symlink — so the
    // first build was right and every edit after it was ignored, silently.
    const app = path.join(tempDir, 'app')
    const pkg = path.join(tempDir, 'packages', 'tokens')
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
    fs.mkdirSync(path.join(app, 'node_modules', '@acme'), { recursive: true })
    fs.mkdirSync(path.join(app, 'generated'), { recursive: true })

    const tokenSource = path.join(pkg, 'src', 'color.json')
    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#111111' } } }),
    )
    fs.symlinkSync(
      pkg,
      path.join(app, 'node_modules', '@acme', 'tokens'),
      'dir',
    )

    const configFile = path.join(app, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          js: {
            buildPath: posix(path.join(app, 'generated')) + '/',
            files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [
          posix(path.join(app, 'node_modules', '@acme', 'tokens', 'src')) +
            '/*.json',
        ],
      }),
    )

    const entry = path.join(app, 'entry.js')
    fs.writeFileSync(
      entry,
      [
        "import { ColorBrand } from './generated/tokens.js'",
        'export const brand = ColorBrand',
        '',
      ].join('\n'),
    )

    const generated = path.join(app, 'generated', 'tokens.js')
    const current = () =>
      fs.existsSync(generated) ? fs.readFileSync(generated, 'utf-8') : ''

    const watcher = rolldown.watch({
      input: entry,
      output: { dir: path.join(app, 'dist'), format: 'es' },
      plugins: [
        rolldownPlugin({ cache: false, config: configFile, silent: true }),
      ],
    })

    try {
      await waitUntil(() => current().includes('#111111'), 20000)
      expect(current()).toContain('#111111')

      // The watcher reports nothing for a moment after it is built.
      await settle(500)

      // The real file, as an editor working in `packages/tokens` saves it.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#222222' } } }),
      )

      await waitUntil(() => current().includes('#222222'), 20000)
      expect(current()).toContain('#222222')
    } finally {
      await watcher.close()
    }
  }, 60000)
})
