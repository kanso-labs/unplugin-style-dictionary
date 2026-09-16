import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as rolldown from 'rolldown'
import * as rollup from 'rollup'
import * as vite from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import webpack from 'webpack'

import rolldownPlugin from '../src/rolldown.ts'
import rollupPlugin from '../src/rollup.ts'
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

// One entry per target: how to run a single build of `directory` and hand back
// whatever the bundler emitted, so the assertions below can be written once.
const TARGETS = [
  {
    build: async (directory: string, configFile: string) => {
      const bundle = await rollup.rollup({
        input: path.join(directory, 'entry.js'),
        plugins: [rollupPlugin({ config: configFile, silent: true })],
      })
      const { output } = await bundle.generate({ format: 'es' })
      await bundle.close()

      return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('')
    },
    name: 'rollup',
  },
  {
    build: async (directory: string, configFile: string) => {
      const bundle = await rolldown.rolldown({
        input: path.join(directory, 'entry.js'),
        plugins: [rolldownPlugin({ config: configFile, silent: true })],
      })
      const { output } = await bundle.generate({ format: 'es' })
      await bundle.close()

      return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('')
    },
    name: 'rolldown',
  },
  {
    build: async (directory: string, configFile: string) => {
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
        logLevel: 'silent',
        plugins: [vitePlugin({ config: configFile, silent: true })],
        root: directory,
      })

      return fs.readFileSync(path.join(directory, 'dist', 'out.mjs'), 'utf-8')
    },
    name: 'vite',
  },
  {
    build: async (directory: string, configFile: string) => {
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

      const errors = stats?.toJson().errors ?? []
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

      // Settling at all is half the assertion — a configuration that rejects a
      // promise nobody holds is what used to leave a host building forever —
      // and rejecting is the other half, since a broken token set must not
      // pass for a successful build on any target.
      await expect(build(directory, configFile)).rejects.toThrow(
        /JSON5|invalid|Failed to load/i,
      )
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

  // What rolldown does with a token edit is platform-dependent, so this case
  // asserts nothing about it — see the note in AGENTS.md. What it does assert
  // holds everywhere: an edit rolldown certainly sees, to a file in its own
  // module graph, rebuilds and then stops. The generated file is in that graph
  // too, which is the shape a rebuild loop closes through.
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

      // Edited, and then deliberately not asserted on either way. Whether this
      // reaches a rebuild depends on the platform's watch backend: measured
      // inert on macOS and delivered on Linux. It is here so the entry edit
      // below lands on a plugin that has already had a token change to react
      // to, which is the busier of the two states.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )
      await settle(1500)

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
