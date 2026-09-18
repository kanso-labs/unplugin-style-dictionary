// TEMPORARY — a diagnostic for #307, removed once it has answered.
//
// Round 3. Rounds 1 and 2 asked the watcher what it was watching, and on
// Windows `getWatched()` returns an empty object — no root, no generated
// directory, nothing — while other dev-server cases pass there. So it reports
// nothing useful on that platform and cannot be used to tell a working watch
// from a broken one.
//
// This round measures behaviour instead: boot a server per candidate negation
// shape, edit the token file, and report whether the rebuild happened. A
// control outside `node_modules` says whether watching works at all.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

import vitePlugin from '../src/vite.ts'

const posix = (value: string) => value.replace(/\\/g, '/')

const report = (label: string, value: unknown) => {
  // eslint-disable-next-line no-console
  console.log(`PROBE ${label}: ${JSON.stringify(value)}`)
}

const waitFor = async (satisfied: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (satisfied()) return true
    await new Promise((settle) => setTimeout(settle, 100))
  }

  return satisfied()
}

// One fixture per case, because a rebuild in one must not be read as a rebuild
// in another.
const buildFixture = (tempDir: string, name: string, insideNodeModules: boolean) => {
  const base = path.join(tempDir, name)
  const app = path.join(base, 'app')
  const pkg = path.join(base, 'packages', 'tokens')

  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  fs.mkdirSync(path.join(app, 'generated'), { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@acme/tokens', version: '1.0.0' }),
  )
  fs.writeFileSync(
    path.join(pkg, 'src', 'color.json'),
    JSON.stringify({ color: { brand: { value: '#123456' } } }),
  )

  let tokenSource = path.join(pkg, 'src', 'color.json')
  if (insideNodeModules) {
    fs.mkdirSync(path.join(app, 'node_modules', '@acme'), { recursive: true })
    fs.symlinkSync(pkg, path.join(app, 'node_modules', '@acme', 'tokens'), 'dir')
    tokenSource = path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json')
  }

  const configFile = path.join(app, 'sd.config.json')
  const generated = path.join(app, 'generated', 'vars.css')
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
      source: [posix(tokenSource)],
    }),
  )

  return { app, configFile, generated, tokenSource: posix(tokenSource) }
}

const measure = async (
  tempDir: string,
  label: string,
  { extraIgnored = [], insideNodeModules = true } = {},
) => {
  const { app, configFile, generated, tokenSource } = buildFixture(
    tempDir,
    label.replace(/[^a-z0-9]+/gi, '-'),
    insideNodeModules,
  )

  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
    root: app,
    server: { host: '127.0.0.1', watch: { ignored: extraIgnored } },
  })
  await server.listen()

  try {
    await waitFor(() => fs.existsSync(generated), 10000)
    const first = fs.existsSync(generated)
      ? fs.readFileSync(generated, 'utf-8').includes('#123456')
      : false

    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
    )

    const rebuilt = await waitFor(
      () =>
        fs.existsSync(generated) &&
        fs.readFileSync(generated, 'utf-8').includes('#ff0000'),
      8000,
    )

    report(label, { firstBuildCorrect: first, rebuiltOnEdit: rebuilt })
  } finally {
    await server.close()
  }
}

it('reports which negation shape rebuilds a node_modules token', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-win-probe-'))
  report('platform', process.platform)

  try {
    // The control. If this does not rebuild, watching is broken generally and
    // `node_modules` is not the subject at all.
    await measure(tempDir, 'control outside node_modules', {
      insideNodeModules: false,
    })

    // What ships today: the plugin's own file-only negation, nothing added.
    await measure(tempDir, 'file negation only (today)')

    // Every directory on the path un-ignored as well as the file, in case the
    // walk is pruned at a directory before it can reach the leaf.
    const ancestors = (root: string) => [
      `!${posix(path.join(root, 'node_modules'))}`,
      `!${posix(path.join(root, 'node_modules', '@acme'))}`,
      `!${posix(path.join(root, 'node_modules', '@acme', 'tokens'))}`,
      `!${posix(path.join(root, 'node_modules', '@acme', 'tokens', 'src'))}`,
    ]
    const ancestorRoot = path.join(
      tempDir,
      'plus-ancestor-negations'.replace(/[^a-z0-9]+/gi, '-'),
      'app',
    )
    await measure(tempDir, 'plus ancestor negations', {
      extraIgnored: ancestors(ancestorRoot),
    })

    // The package subtree, which is broader than a leaf and narrower than the
    // whole dependency tree.
    const subtreeRoot = path.join(
      tempDir,
      'plus-package-subtree'.replace(/[^a-z0-9]+/gi, '-'),
      'app',
    )
    await measure(tempDir, 'plus package subtree', {
      extraIgnored: [
        `!${posix(path.join(subtreeRoot, 'node_modules', '@acme', 'tokens'))}/**`,
      ],
    })
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }

  expect(true).toBe(true)
}, 120000)
