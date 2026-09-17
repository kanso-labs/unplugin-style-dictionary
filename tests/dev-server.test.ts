import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import StyleDictionary from 'style-dictionary'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UnpluginStyleDictionaryOptions } from '../src/types.ts'

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

// A frame as it arrives on the wire. Only the fields the assertions read are
// named; Vite's payloads carry more.
type HmrFrame = {
  err?: { message?: string; plugin?: string }
  type: string
}

// A type predicate rather than an assertion, for the reason `src/index.ts`
// gives for the same choice at its own config boundary: a predicate is a check
// the compiler verifies, where a cast is only a claim.
const isHmrFrame = (value: unknown): value is HmrFrame =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string'

// `JSON.parse` hands back `any`, so what comes off the socket is narrowed here
// once. Anything that fails the guard is dropped rather than counted as a
// frame — which matters, because two of the cases below assert that no frame
// of a given type arrived at all.
const asHmrFrame = (data: unknown): HmrFrame | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(data))
  } catch {
    return null
  }

  return isHmrFrame(parsed) ? parsed : null
}

// Style Dictionary reports an unresolvable reference by count, so two broken
// references produce a message that differs from one broken reference's.
const breakReferences = (tokenSource: string, count: number) => {
  const color: Record<string, { value: string }> = {}
  for (let index = 0; index < count; index++) {
    color[`broken${index}`] = { value: `{color.missing${index}.value}` }
  }
  fs.writeFileSync(tokenSource, JSON.stringify({ color }))
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

  // A real client on the same `vite-hmr` subprotocol Vite's own browser client
  // uses, reading frames off the socket. Spying on `server.hot.send` would pass
  // just as happily on a payload Vite declines to transmit, and the claim here
  // is that the failure reaches the page.
  const connectHmrClient = async (running: ViteDevServer) => {
    const url = running.resolvedUrls?.local[0]
    if (!url) throw new Error('the dev server reported no local URL')

    const frames: HmrFrame[] = []
    const socket = new WebSocket(url.replace(/^http/, 'ws'), 'vite-hmr')

    socket.addEventListener('message', (event) => {
      const frame = asHmrFrame(event.data)
      if (frame) frames.push(frame)
    })

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve()
      })
      socket.addEventListener('error', () => {
        reject(new Error('could not open an hmr connection'))
      })
    })

    return { frames, socket }
  }

  // `logLevel: 'silent'` rather than the `'warn'` that is usually right for a
  // test not asserting on the progress lines. `'warn'` leaves Style
  // Dictionary's own file table on stdout, and nothing here reads it; the one
  // thing these cases do assert on is the failure report, which is printed at
  // every level including this one, so silencing the rest costs them nothing.
  //
  // The rest of this file runs in middleware mode with HMR off, which is what
  // keeps a websocket server from outliving a test. The overlay cases cannot:
  // the thing under test is a frame on that socket. Vite picks the port rather
  // than this pinning one, and the host is spelled numerically because
  // `localhost` resolves to ::1 first on some machines while the server is
  // listening on 127.0.0.1 — a mismatch that fails as a refused connection.
  const bootServing = async (
    root: string,
    config: string,
    overrides: Partial<UnpluginStyleDictionaryOptions> = {},
  ) => {
    // The plugin's lines now go through Vite's logger rather than the console,
    // so a `console.error` spy sees nothing and a `logLevel: 'silent'` server
    // would discard the report before anything could read it. A recording
    // logger replaces both: it keeps the suite quiet and is where the failure
    // report actually arrives.
    const logged: string[] = []
    const record = (message: string) => {
      logged.push(message)
    }

    server = await createServer({
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
      plugins: [vitePlugin({ config, logLevel: 'silent', ...overrides })],
      root,
      server: { host: '127.0.0.1' },
    })

    await server.listen()
    return { logged, server }
  }

  it('pushes a failed rebuild to the overlay and clears it on the next success', async () => {
    const { configFile, directory, generated, tokenSource } =
      writeFixture('overlay-error')

    const { logged, server: running } = await bootServing(directory, configFile)
    await waitUntil(() => fs.existsSync(generated), 10000)

    const { frames, socket } = await connectHmrClient(running)
    await settle(300)
    frames.length = 0

    // A failed compile is reported at every log level, `silent` included, so
    // it reaches the console whatever the plugin was configured with. Spied so
    // the suite stays quiet, and asserted so the spy cannot become the thing
    // that hides a regression in the report itself.
    try {
      // A rebuild that succeeds with no overlay standing sends nothing at all.
      // The clearing frame is not free: Vite's client spends a one-time flag on
      // the first update it sees, and reloads the page rather than clearing if
      // an overlay is showing when it arrives. Sending one per successful
      // rebuild would spend that flag on a build nothing was wrong with.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#123456' } } }),
      )
      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#123456'),
        10000,
      )
      await settle(500)
      expect(frames.filter((f) => f.type === 'update')).toEqual([])

      breakReferences(tokenSource, 1)
      await waitUntil(() => frames.some((f) => f.type === 'error'), 10000)

      expect(logged.some((line) => line.includes('Compilation failed'))).toBe(
        true,
      )

      const failure = frames.find((f) => f.type === 'error')
      expect(failure?.err?.plugin).toBe('unplugin-style-dictionary')
      expect(failure?.err?.message).toContain('Reference Errors')

      // The page went on rendering the last good file, which is the whole
      // reason the frame above has to exist.
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#123456')

      frames.length = 0

      // Vite's protocol has no "clear the overlay" frame; its client takes the
      // overlay down when an update arrives, so an empty update is the clear.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#00ff00' } } }),
      )

      await waitUntil(() => frames.some((f) => f.type === 'update'), 10000)
      expect(frames.some((f) => f.type === 'update')).toBe(true)
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#00ff00')
    } finally {
      socket.close()
    }
  }, 30000)

  it('replaces the overlay when the next failure says something different', async () => {
    // Sent on every failure rather than only on the way into one. Vite's client
    // replaces the overlay wholesale, so a repeat costs nothing — and two
    // different failures in a row must not leave the first one's message on
    // screen describing the second.
    const { configFile, directory, generated, tokenSource } =
      writeFixture('overlay-replace')

    const { logged, server: running } = await bootServing(directory, configFile)
    await waitUntil(() => fs.existsSync(generated), 10000)

    const { frames, socket } = await connectHmrClient(running)
    await settle(300)
    frames.length = 0

    try {
      breakReferences(tokenSource, 1)
      await waitUntil(() => frames.some((f) => f.type === 'error'), 10000)
      expect(frames.at(-1)?.err?.message).toContain('(1)')

      frames.length = 0

      breakReferences(tokenSource, 2)
      await waitUntil(
        () => frames.some((f) => f.err?.message?.includes('(2)') === true),
        10000,
      )

      expect(logged.some((line) => line.includes('Compilation failed'))).toBe(
        true,
      )
      expect(frames.at(-1)?.type).toBe('error')
      expect(frames.at(-1)?.err?.message).toContain('(2)')
    } finally {
      socket.close()
    }
  }, 30000)

  it('sends nothing to the page when errorOverlay is off', async () => {
    const { configFile, directory, generated, tokenSource } =
      writeFixture('overlay-disabled')

    const { logged, server: running } = await bootServing(
      directory,
      configFile,
      { errorOverlay: false },
    )
    await waitUntil(() => fs.existsSync(generated), 10000)

    const { frames, socket } = await connectHmrClient(running)
    await settle(300)
    frames.length = 0

    try {
      breakReferences(tokenSource, 1)

      // Waited out rather than polled for, because the assertion is that
      // nothing arrives: the terminal report is what says the rebuild has been
      // and gone, and the frames are read after it.
      await waitUntil(
        () => logged.some((line) => line.includes('Compilation failed')),
        10000,
      )
      await settle(1000)

      // The terminal line is unchanged — the option governs the page, not the
      // report.
      expect(logged.some((line) => line.includes('Compilation failed'))).toBe(
        true,
      )
      expect(frames.filter((f) => f.type === 'error')).toEqual([])

      frames.length = 0

      // And the success that follows sends no clear either, since there is no
      // overlay of this plugin's to take down.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#00ff00' } } }),
      )
      await waitUntil(
        () => fs.readFileSync(generated, 'utf-8').includes('#00ff00'),
        10000,
      )
      await settle(1000)

      expect(frames.filter((f) => f.type === 'update')).toEqual([])
    } finally {
      socket.close()
    }
  }, 30000)
})
