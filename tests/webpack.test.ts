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
describe('under a real webpack compiler', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-webpack-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

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
