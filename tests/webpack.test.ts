import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import webpack from 'webpack'

import webpackPlugin from '../src/webpack.ts'

// webpack is the one host that reports a root of its own and does not run in
// the directory it names. `context` is where it resolves everything from, and
// the plugin used to ignore it — so a build whose context was not the working
// directory looked for the configuration in the wrong place and reported
// ENOENT before failing on the module it could not resolve.
// Builds the fixture with an async `config` function that yields for a known
// time. That latency is the whole experiment: a real one has it — a remote
// fetch, a transpiled TypeScript config, a child process — while Style
// Dictionary's own work is CPU-bound and blocks the loop, which is what masked
// the race on ordinary configurations.
const buildWithSlowConfig = async (context: string, delayMs: number) => {
  return new Promise<undefined | webpack.Stats>((resolve, reject) => {
    webpack(
      {
        context,
        entry: './entry.js',
        mode: 'development',
        output: { path: path.join(context, 'dist') },
        plugins: [
          webpackPlugin({
            config: async () => {
              await new Promise((yieldTo) => setTimeout(yieldTo, delayMs))

              return {
                platforms: {
                  js: {
                    buildPath:
                      path.join(context, 'generated').replace(/\\/g, '/') + '/',
                    files: [
                      { destination: 'tokens.js', format: 'javascript/es6' },
                    ],
                    transformGroup: 'js',
                  },
                },
                source: [
                  path.join(context, 'tokens', '*.json').replace(/\\/g, '/'),
                ],
              }
            },
            silent: true,
          }),
        ],
      },
      (error, result) => {
        if (error) reject(error)
        else resolve(result)
      },
    )
  })
}

describe('under a real webpack compiler', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-webpack-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // A fixture whose entry imports the generated file, so webpack has to
  // resolve it — which is the thing that used to happen while the compile was
  // still running.
  const writeRaceFixture = (name: string, stale?: string) => {
    const context = path.join(tempDir, name)
    fs.mkdirSync(path.join(context, 'tokens'), { recursive: true })
    fs.mkdirSync(path.join(context, 'generated'), { recursive: true })

    fs.writeFileSync(
      path.join(context, 'tokens', 'color.json'),
      JSON.stringify({ color: { primary: { value: '#00ff00' } } }),
    )
    fs.writeFileSync(
      path.join(context, 'entry.js'),
      [
        "import { ColorPrimary } from './generated/tokens.js'",
        'export const primary = ColorPrimary',
        '',
      ].join('\n'),
    )

    // Pre-seeding is what turns the race from an error into silence: with a
    // file already there webpack resolves it happily and bundles whatever it
    // held when the read happened.
    if (stale !== undefined) {
      fs.writeFileSync(
        path.join(context, 'generated', 'tokens.js'),
        `export const ColorPrimary = "${stale}";\n`,
      )
    }

    return context
  }

  it('compiles before webpack resolves the generated module', async () => {
    const context = writeRaceFixture('race')

    const stats = await buildWithSlowConfig(context, 400)

    // Unpatched this is `Module not found: Error: Can't resolve
    // './generated/tokens.js'` from about 10ms of real latency upward.
    expect(stats?.toJson().errors ?? []).toEqual([])
    expect(
      fs.readFileSync(path.join(context, 'dist', 'main.js'), 'utf-8'),
    ).toContain('#00ff00')
  }, 60000)

  it('does not bundle a stale generated file it is about to replace', async () => {
    // The failure worth fixing, because nothing reports it: with a generated
    // file already on disk the build succeeds and ships the old values, in
    // the same run the plugin logs as a success.
    const context = writeRaceFixture('stale', '#STALE00')

    const stats = await buildWithSlowConfig(context, 50)

    expect(stats?.toJson().errors ?? []).toEqual([])

    const bundle = fs.readFileSync(
      path.join(context, 'dist', 'main.js'),
      'utf-8',
    )
    expect(bundle).toContain('#00ff00')
    expect(bundle).not.toContain('#STALE00')

    // And the fresh value really was written, so the assertion above is about
    // what webpack read rather than about what the plugin produced.
    expect(
      fs.readFileSync(path.join(context, 'generated', 'tokens.js'), 'utf-8'),
    ).toContain('#00ff00')
  }, 60000)

  it('finds a config relative to the compiler context', async () => {
    const context = path.join(tempDir, 'app')
    fs.mkdirSync(path.join(context, 'tokens'), { recursive: true })

    fs.writeFileSync(
      path.join(context, 'tokens', 'color.json'),
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    // Absolute, because what is under test is whether the *configuration* is
    // found under `context`. Style Dictionary reads the paths inside it
    // against the working directory, which is not `context` here, and that
    // separation is the documented contract.
    fs.writeFileSync(
      path.join(context, 'sd.config.json'),
      JSON.stringify({
        platforms: {
          js: {
            buildPath:
              path.join(context, 'generated').replace(/\\/g, '/') + '/',
            files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [path.join(context, 'tokens', '*.json').replace(/\\/g, '/')],
      }),
    )

    fs.writeFileSync(path.join(context, 'entry.js'), 'export const entry = 1\n')

    const stats = await new Promise<undefined | webpack.Stats>(
      (resolve, reject) => {
        webpack(
          {
            context,
            entry: './entry.js',
            mode: 'development',
            output: { path: path.join(tempDir, 'dist') },
            // `config` is relative, so only the compiler's context can find it.
            plugins: [
              webpackPlugin({ config: 'sd.config.json', silent: true }),
            ],
          },
          (error, result) => {
            if (error) reject(error)
            else resolve(result)
          },
        )
      },
    )

    expect(stats?.hasErrors()).toBe(false)

    const generated = path.join(context, 'generated', 'tokens.js')
    expect(fs.existsSync(generated)).toBe(true)
    expect(fs.readFileSync(generated, 'utf-8')).toContain('#0070f3')
  }, 60000)
})
