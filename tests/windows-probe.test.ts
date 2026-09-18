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
const buildFixture = (
  tempDir: string,
  name: string,
  insideNodeModules: boolean,
  viaSymlink: boolean,
) => {
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

  // Two independent axes. The original fixture moved both at once, so a
  // failure could not say which of them caused it.
  let tokenSource = path.join(pkg, 'src', 'color.json')
  const host = insideNodeModules
    ? path.join(app, 'node_modules', '@acme')
    : path.join(app, 'linked')

  if (insideNodeModules || viaSymlink) {
    fs.mkdirSync(host, { recursive: true })

    if (viaSymlink) {
      fs.symlinkSync(pkg, path.join(host, 'tokens'), 'dir')
    } else {
      // A real directory in the same place, so the only difference from the
      // symlinked case is the symlink.
      fs.mkdirSync(path.join(host, 'tokens', 'src'), { recursive: true })
      fs.writeFileSync(
        path.join(host, 'tokens', 'src', 'color.json'),
        JSON.stringify({ color: { brand: { value: '#123456' } } }),
      )
    }

    tokenSource = path.join(host, 'tokens', 'src', 'color.json')
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
  {
    extraIgnored = [],
    insideNodeModules = true,
    viaSymlink = true,
    watcherAdd = false,
    ownWatcher = false,
  } = {},
) => {
  const { app, configFile, generated, tokenSource } = buildFixture(
    tempDir,
    label.replace(/[^a-z0-9]+/gi, '-'),
    insideNodeModules,
    viaSymlink,
  )

  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
    root: app,
    server: { host: '127.0.0.1', watch: { ignored: extraIgnored } },
  })
  await server.listen()

  // Candidate fixes, applied after the server is up — which is where a plugin
  // would reach them from `configureServer`.
  let own: fs.FSWatcher | undefined
  if (watcherAdd) server.watcher.add(tokenSource)
  if (ownWatcher) {
    // A watcher of the plugin's own, on the file's directory, bypassing Vite's
    // ignore list entirely. `fs.watch` rather than chokidar because chokidar is
    // not a direct dependency here; what is under test is whether the OS
    // reports the change at all inside `node_modules`.
    own = fs.watch(path.dirname(tokenSource), () => {
      server.watcher.emit('change', tokenSource)
    })
  }

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
    own?.close()
    await server.close()
  }
}

it('reports which negation shape rebuilds a node_modules token', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-win-probe-'))
  report('platform', process.platform)

  try {
    // Round 5. The 2x2 in round 4 was decisive: inside `node_modules` fails
    // and outside succeeds, with or without a symlink — so `node_modules` is
    // the variable and the symlink is not. Round 3 had already shown that no
    // negation shape helps. So the question is no longer how to spell the
    // negation but what to do instead of one.
    await measure(tempDir, 'D today (negation only)', {})

    // Does asking the watcher directly, once it is running, reach the file?
    await measure(tempDir, 'E negation plus watcher.add', { watcherAdd: true })

    // Does the OS report the change at all inside `node_modules`? If a plain
    // `fs.watch` sees it, a watcher of the plugin's own is a viable fix and
    // Vite's ignore list is simply not reachable on this platform.
    await measure(tempDir, 'F own fs.watch, no negation reliance', {
      ownWatcher: true,
    })

  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }

  expect(true).toBe(true)
}, 120000)
