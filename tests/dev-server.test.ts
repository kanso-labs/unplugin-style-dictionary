import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import StyleDictionary from 'style-dictionary'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import vitePlugin from '../src/vite.ts'

// The dev server is the plugin's headline feature — the README sells
// "automatic watching, rebuilding, and hot reloading (HMR) under Vite's dev
// server" — and no test had ever started one. Everything in `configureServer`
// was unexecuted, including the watcher listener that holds both the rebuild
// trigger and the guard keeping the plugin off its own output.

const posix = (value: string) => value.replace(/\\/g, '/')

const settle = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Polled to a deadline rather than slept for a fixed interval. Watcher latency
// on a loaded runner is what turns a fixed sleep into a flake, and a poll costs
// nothing when the rebuild is fast.
const waitUntil = async (satisfied: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await settle(25)
}

describe('under a real vite dev server', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-dev-server-'),
  )

  let server: undefined | ViteDevServer

  afterEach(async () => {
    await server?.close()
    server = undefined

    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // `buildPath` sits outside the source tree by default, which is the layout
  // the own-output case below inverts.
  const writeFixture = (
    name: string,
    {
      buildPath = 'generated',
      destination = 'tokens.js',
      format = 'javascript/es6',
      value = '#0070f3',
    } = {},
  ) => {
    const directory = path.join(tempDir, name)
    const tokensDirectory = path.join(directory, 'tokens')
    fs.mkdirSync(tokensDirectory, { recursive: true })
    fs.mkdirSync(path.join(directory, buildPath), { recursive: true })

    const tokenSource = path.join(tokensDirectory, 'color.json')
    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value } } }),
    )

    const configFile = path.join(directory, 'sd.config.json')
    const writeConfig = (into: string) => {
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          platforms: {
            js: {
              buildPath: posix(path.join(directory, buildPath)) + '/',
              files: [{ destination: into, format }],
              transformGroup: 'js',
            },
          },
          source: [posix(tokensDirectory) + '/**/*.json'],
        }),
      )
    }
    writeConfig(destination)

    return {
      configFile,
      directory,
      generated: path.join(directory, buildPath, destination),
      tokenSource,
      writeConfig,
    }
  }

  // Middleware mode so nothing binds a port, and HMR off so no websocket
  // server outlives the test.
  const boot = async (root: string, config: string) => {
    server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin({ config, silent: true })],
      root,
      server: { hmr: false, middlewareMode: true },
    })

    return server
  }

  it('rebuilds when a file under the source glob is edited', async () => {
    const { configFile, directory, generated, tokenSource } =
      writeFixture('source-edit')

    await boot(directory, configFile)
    await waitUntil(() => fs.existsSync(generated), 10000)
    expect(fs.readFileSync(generated, 'utf-8')).toContain('#0070f3')

    // chokidar reports nothing for a moment after the watcher is built, and an
    // edit landing inside that window is missed by the watcher rather than by
    // the plugin.
    await settle(300)

    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
    )

    await waitUntil(
      () => fs.readFileSync(generated, 'utf-8').includes('#ff0000'),
      10000,
    )
    expect(fs.readFileSync(generated, 'utf-8')).toContain('#ff0000')
  }, 30000)

  it('rebuilds with the new configuration when the config file is edited', async () => {
    const { configFile, directory, generated, writeConfig } =
      writeFixture('config-edit')

    await boot(directory, configFile)
    await waitUntil(() => fs.existsSync(generated), 10000)

    await settle(300)

    // A renamed destination is the assertion, because it can only come from
    // the edited configuration rather than from a rebuild of the old one.
    writeConfig('renamed.js')

    const renamed = path.join(directory, 'generated', 'renamed.js')
    await waitUntil(() => fs.existsSync(renamed), 10000)
    expect(fs.readFileSync(renamed, 'utf-8')).toContain('#0070f3')
  }, 30000)

  it('does not rebuild for a change to its own generated output', async () => {
    // `buildPath` inside the source directory is a supported layout, and the
    // one where the output matches the very glob that produced it. The guard
    // subtracting what the plugin itself wrote is the only thing that can tell
    // the two apart, because the pattern cannot.
    // The destination is a `.json` file written into the source directory, so
    // it matches `tokens/**/*.json` — the very glob that produced it. A `.js`
    // output there would not match, and the case would exercise nothing.
    const { configFile, directory, generated } = writeFixture('own-output', {
      buildPath: 'tokens',
      destination: 'generated-tokens.json',
      format: 'json/flat',
    })

    const buildSpy = vi.spyOn(StyleDictionary.prototype, 'buildAllPlatforms')
    try {
      await boot(directory, configFile)
      await waitUntil(() => fs.existsSync(generated), 10000)
      expect(buildSpy.mock.calls.length).toBeGreaterThan(0)

      // The baseline is taken after the server has gone quiet rather than at
      // the first build, because the spy is on a shared prototype: a rebuild
      // still in flight from an earlier case in this file would otherwise be
      // counted against this one.
      await settle(500)
      const beforeTouch = buildSpy.mock.calls.length

      // Written with contents the plugin did not produce, and that is what
      // makes the case non-vacuous. A rebuild rendering what is already on
      // disk skips its own `rename` and so emits no event at all — so letting
      // the plugin's own write stand in for this would pass with the guard
      // removed, which was checked. Changing the bytes forces a real watcher
      // event for a path that matches the source glob and is the plugin's.
      fs.writeFileSync(generated, JSON.stringify({ touched: 'not by us' }))

      await settle(2000)

      expect(buildSpy.mock.calls.length).toBe(beforeTouch)
    } finally {
      buildSpy.mockRestore()
    }
  }, 30000)

  it('compiles once for one write, not once per trigger', async () => {
    // Vite invokes the plugin's `watchChange` while serving *and* the
    // `configureServer` listener fires, so one edit reaches two entry points.
    // Both go through the scheduler, which is what collapses them into a
    // single build — without it one write produced two overlapping builds.
    const { configFile, directory, generated, tokenSource } =
      writeFixture('single-compile')

    const buildSpy = vi.spyOn(StyleDictionary.prototype, 'buildAllPlatforms')
    try {
      await boot(directory, configFile)
      await waitUntil(() => fs.existsSync(generated), 10000)

      await settle(300)
      const afterFirstBuild = buildSpy.mock.calls.length

      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#00ff00' } } }),
      )

      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#00ff00'),
        10000,
      )

      // Settled after the edit landed, so a second build that was merely slow
      // is still counted rather than missed.
      await settle(1000)

      expect(buildSpy.mock.calls.length - afterFirstBuild).toBe(1)
    } finally {
      buildSpy.mockRestore()
    }
  }, 30000)
})
