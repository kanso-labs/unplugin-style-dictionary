// TEMPORARY — a diagnostic for #307, removed once it has answered.
//
// The node_modules negation does not reach the watcher on Windows, and #307 is
// explicit that what chokidar matches a path against there has to be
// established before anything is changed. This prints the three things that
// could differ: what the plugin generates, what the watcher holds, and what
// the matcher makes of the pair.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

import vitePlugin from '../src/vite.ts'

const posix = (value: string) => value.replace(/\\/g, '/')

it('reports what the watcher matches a node_modules path against', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-win-probe-'))
  const base = path.join(tempDir, 'node-modules-source')
  const app = path.join(base, 'app')
  const pkg = path.join(base, 'packages', 'tokens')

  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  fs.mkdirSync(path.join(app, 'node_modules', '@acme'), { recursive: true })
  fs.mkdirSync(path.join(app, 'generated'), { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@acme/tokens', version: '1.0.0' }),
  )
  fs.writeFileSync(
    path.join(pkg, 'src', 'color.json'),
    JSON.stringify({ color: { brand: { value: '#123456' } } }),
  )
  fs.symlinkSync(pkg, path.join(app, 'node_modules', '@acme', 'tokens'), 'dir')

  const viaNodeModules = posix(
    path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json'),
  )

  const configFile = path.join(app, 'sd.config.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      platforms: {
        css: {
          buildPath: posix(path.join(app, 'generated')) + '/',
          files: [{ destination: 'vars.css', format: 'css/variables' }],
          transformGroup: 'css',
        },
      },
      source: [viaNodeModules],
    }),
  )

  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
    root: app,
    server: { host: '127.0.0.1' },
  })
  await server.listen()

  const report = (label: string, value: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`PROBE ${label}: ${JSON.stringify(value)}`)
  }

  try {
    report('platform', process.platform)
    report('os.tmpdir', os.tmpdir())
    report('token path as built', viaNodeModules)
    report('token path realpath', posix(fs.realpathSync(viaNodeModules)))
    report('token path native', path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json'))

    const ignored = server.config.server.watch?.ignored
    report(
      'ignored entries mentioning node_modules',
      (Array.isArray(ignored) ? ignored : [ignored])
        .filter((entry) => typeof entry === 'string' && entry.includes('node_modules'))
        .slice(0, 6),
    )

    // What the watcher actually holds, which is the set the negation had to
    // reach. Only the node_modules half, so the output stays readable.
    const watched = server.watcher.getWatched()
    const dirs = Object.keys(watched).filter((d) => d.includes('node_modules'))
    report('watched dirs mentioning node_modules', dirs.slice(0, 6))
    report(
      'watched entries under those dirs',
      dirs.slice(0, 3).map((d) => `${d} -> ${(watched[d] ?? []).join(',')}`),
    )

    // The matcher anymatch uses, asked directly about the pair.
    const pm = (await import('picomatch')).default
    const negation = viaNodeModules
    for (const candidate of [
      viaNodeModules,
      posix(fs.realpathSync(viaNodeModules)),
      path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json'),
    ]) {
      report(
        `picomatch("${negation.slice(-40)}") vs "${candidate.slice(-40)}"`,
        pm(negation)(posix(candidate)),
      )
    }
  } finally {
    await server.close()
    fs.rmSync(tempDir, { force: true, recursive: true })
  }

  expect(true).toBe(true)
}, 60000)
