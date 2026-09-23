import type { ViteDevServer } from 'vite'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import StyleDictionary from 'style-dictionary'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  StyleDictionaryConfigContext,
  UnpluginStyleDictionaryOptions,
} from '../src/types.ts'

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
      tokensDirectory,
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
    // `unknown[]`, not `string[]`, because Vite's logger is typed for strings
    // and does not only pass them: a rejected rebuild arrives as its own
    // `Error` object. Every read below coerces, which is why the type is
    // honest rather than convenient.
    const logged: unknown[] = []
    const record = (message: unknown) => {
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

      expect(
        logged.some((line) => String(line).includes('Compilation failed')),
      ).toBe(true)

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

  it('reports and shows a rebuild that fails outside the compile', async () => {
    // `drain` wraps two different things: resolving the configurations, and
    // building them. `runBuilds` reports its own failure, so the catch only
    // has to speak for the other half — a `config` function of the consumer's
    // that throws, or a watch list that cannot be rebuilt. Nothing drove a
    // throwing `config` function under a live scheduler, so neither the
    // `Rebuild failed:` report nor the overlay it raises had ever run.
    const { directory, generated, tokenSource } = writeFixture('rebuild-throw')

    // Armed after the first build lands. The first call has to succeed for a
    // watcher to exist at all, and the dev server resolves configurations more
    // than once on the way up, so the test says when rather than counting.
    let armed = false

    const { logged, server: running } = await bootServing(
      directory,
      path.join(directory, 'sd.config.json'),
      {
        config: () => {
          if (armed) throw new Error('the config function refused')

          return {
            platforms: {
              js: {
                buildPath: posix(path.join(directory, 'generated')) + '/',
                files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
                transformGroup: 'js',
              },
            },
            source: [posix(path.join(directory, 'tokens')) + '/**/*.json'],
          }
        },
      },
    )

    await waitUntil(() => fs.existsSync(generated), 10000)

    const { frames, socket } = await connectHmrClient(running)
    await settle(300)
    frames.length = 0

    try {
      armed = true
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#123456' } } }),
      )

      await waitUntil(() => frames.some((f) => f.type === 'error'), 10000)

      // Both halves of the catch, which are the two lines that had never run.
      // `String(...)` because this is the one case where the recording logger
      // catches something that is not a string: Vite logs the rejected
      // rebuild's own `Error` object beside the plugin's line, and
      // `line.includes` throws on it.
      expect(
        logged.some((line) => String(line).includes('Rebuild failed:')),
        'the failure was never reported',
      ).toBe(true)

      const failure = frames.find((f) => f.type === 'error')
      expect(failure?.err?.plugin).toBe('unplugin-style-dictionary')
      expect(failure?.err?.message).toContain('the config function refused')

      // A failure here is not a failure of the compile, so the last good file
      // is still on disk and the page is still rendering it — which is why the
      // frame above has to exist.
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#0070f3')
    } finally {
      armed = false
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

      expect(
        logged.some((line) => String(line).includes('Compilation failed')),
      ).toBe(true)
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
        () =>
          logged.some((line) => String(line).includes('Compilation failed')),
        10000,
      )
      await settle(1000)

      // The terminal line is unchanged — the option governs the page, not the
      // report.
      expect(
        logged.some((line) => String(line).includes('Compilation failed')),
      ).toBe(true)
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

  it('tells a config function it is serving, not building', async () => {
    // `'serve'` is only reachable under a real dev server: it comes from
    // Vite's own `config.command`, and nothing else here serves. A stubbed
    // context cannot produce it, which is why this case lives beside a server
    // rather than with the others.
    // The fixture's own config file is unused here: the point is the function
    // form of `config`, which this passes inline instead.
    const { directory, generated, tokensDirectory } =
      writeFixture('config-context')

    const seen: StyleDictionaryConfigContext[] = []

    server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        vitePlugin({
          config: (context) => {
            seen.push(context)

            return {
              platforms: {
                js: {
                  buildPath: posix(path.join(directory, 'generated')) + '/',
                  files: [
                    { destination: 'tokens.js', format: 'javascript/es6' },
                  ],
                  transformGroup: 'js',
                },
              },
              source: [posix(tokensDirectory) + '/**/*.json'],
            }
          },
          logLevel: 'silent',
        }),
      ],
      root: directory,
      server: { hmr: false, middlewareMode: true },
    })

    await waitUntil(() => fs.existsSync(generated), 10000)

    expect(seen.length).toBeGreaterThan(0)

    // Every call agrees, including the one from `configureServer` that runs
    // before `buildStart` — which is why `watch` is set there rather than left
    // to the plugin context, and what would otherwise report `false` while a
    // dev server started up around it.
    for (const context of seen) {
      expect(context.command).toBe('serve')
      expect(context.mode).toBe('development')
      expect(context.watch).toBe(true)
    }
  }, 30000)

  it('rebuilds for a token source that resolves inside node_modules', async () => {
    // The workspace shape, which is the shape of nearly every real project:
    //
    //   app/                                   <- the Vite root
    //     node_modules/@acme/tokens -> ../../packages/tokens   (a real symlink)
    //   packages/tokens/src/color.json
    //
    // Vite builds its watcher with `**/node_modules/**` already in the ignore
    // list and appends the consumer's entries after it, so `watcher.add()`
    // cannot reach the token file. The first build was correct and no edit ever
    // rebuilt, with nothing said about it — measured on Vite 6.4.3, 7.3.6 and
    // 8.3.0 before the fix.
    //
    // A symlink rather than a copied directory on purpose: a workspace install
    // produces one, and the ignore list is matched against the path walked
    // rather than the realpath.
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

    const tokenSource = path.join(pkg, 'src', 'color.json')
    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#123456' } } }),
    )

    fs.symlinkSync(
      pkg,
      path.join(app, 'node_modules', '@acme', 'tokens'),
      'dir',
    )

    // A literal path rather than a glob, so a glob-expansion defect cannot be
    // what this passes or fails on.
    const viaNodeModules = posix(
      path.join(app, 'node_modules', '@acme', 'tokens', 'src', 'color.json'),
    )

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
        source: [viaNodeModules],
      }),
    )

    server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
      root: app,
      server: { hmr: false, middlewareMode: true },
    })

    await waitUntil(() => fs.existsSync(generated), 10000)

    // The half that always worked: Style Dictionary reads through the symlink
    // without trouble, which is why the failure was silent.
    expect(fs.readFileSync(generated, 'utf-8')).toContain(
      '--color-brand: #123456;',
    )

    await settle(300)

    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
    )

    await waitUntil(
      () => fs.readFileSync(generated, 'utf-8').includes('#ff0000'),
      10000,
    )

    // The half that did not. Without the negation this stays at `#123456`
    // forever and no watcher event is ever emitted for the edit.
    expect(fs.readFileSync(generated, 'utf-8')).toContain(
      '--color-brand: #ff0000;',
    )
  }, 30000)

  it('leaves the rest of node_modules ignored', async () => {
    // The negation names each file exactly, and that is the point:
    // `!**/node_modules/**` would hand the whole dependency tree back to the
    // watcher, which on a real project is thousands of files that no token
    // build reads.
    const base = path.join(tempDir, 'node-modules-scope')
    const app = path.join(base, 'app')
    const pkg = path.join(base, 'packages', 'tokens')

    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
    fs.mkdirSync(path.join(app, 'node_modules', '@acme'), { recursive: true })
    fs.mkdirSync(path.join(app, 'node_modules', 'unrelated'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(app, 'generated'), { recursive: true })

    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@acme/tokens', version: '1.0.0' }),
    )
    fs.writeFileSync(
      path.join(pkg, 'src', 'color.json'),
      JSON.stringify({ color: { brand: { value: '#123456' } } }),
    )
    fs.symlinkSync(
      pkg,
      path.join(app, 'node_modules', '@acme', 'tokens'),
      'dir',
    )

    // A file in node_modules the plugin never registered.
    const unrelated = path.join(app, 'node_modules', 'unrelated', 'index.js')
    fs.writeFileSync(unrelated, 'export default 1\n')

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
        source: [
          posix(
            path.join(
              app,
              'node_modules',
              '@acme',
              'tokens',
              'src',
              'color.json',
            ),
          ),
        ],
      }),
    )

    server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
      root: app,
      server: { hmr: false, middlewareMode: true },
    })

    await waitUntil(() => fs.existsSync(generated), 10000)

    const events: string[] = []
    server.watcher.on('all', (_event, file) => {
      events.push(file)
    })

    await settle(300)

    fs.writeFileSync(unrelated, 'export default 2\n')
    await settle(1500)

    expect(events.filter((file) => file.includes('unrelated'))).toEqual([])
  }, 30000)

  it.each([
    {
      label: 'in middleware mode',
      options: { hmr: false, middlewareMode: true },
    },
    { label: 'listening', options: { host: '127.0.0.1' } },
  ])(
    'closes its own node_modules watchers when a server $label closes',
    async ({ label, options }) => {
      // #307 gave a `node_modules` token directory a watcher of the plugin's
      // own, and registered its cleanup on `server.httpServer`'s `close`
      // event. Middleware mode has no `httpServer` — it is how Vite runs under
      // Express, Koa and most SSR setups — so the optional chain registered
      // nothing, and every restart leaked one `fs.watch` handle per directory
      // for the rest of the process. Every other case in this file boots in
      // middleware mode, which is why that cleanup was the one line of #307
      // no test had ever run.
      //
      // A plain directory rather than a symlink: #307's 2x2 showed that
      // `node_modules` is the variable and the symlink is not.
      const app = path.join(
        tempDir,
        `own-watchers-${label.replace(/\W+/g, '-')}`,
      )
      const tokens = path.join(app, 'node_modules', '@acme', 'tokens', 'src')
      fs.mkdirSync(tokens, { recursive: true })
      fs.mkdirSync(path.join(app, 'generated'), { recursive: true })

      const tokenSource = path.join(tokens, 'color.json')
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#123456' } } }),
      )

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

      // Records every `fs.watch` without replacing it, so the returned
      // watchers are the real ones and each can be spied on for its close.
      const watchSpy = vi.spyOn(fs, 'watch')

      try {
        server = await createServer({
          configFile: false,
          logLevel: 'silent',
          plugins: [vitePlugin({ config: configFile, logLevel: 'silent' })],
          root: app,
          server: options,
        })
        if (!('middlewareMode' in options)) await server.listen()

        // Up and built before it is closed, so this is a real shutdown rather
        // than one that races the start-up build.
        await waitUntil(() => fs.existsSync(generated), 10000)

        const ours = watchSpy.mock.calls.flatMap(([watched], index) => {
          const result = watchSpy.mock.results[index]
          return typeof watched === 'string' &&
            watched.includes('node_modules') &&
            result.type === 'return'
            ? [result.value]
            : []
        })

        // Guards the assertion below against passing vacuously: "every
        // watcher was closed" is true of none at all.
        expect(ours.length).toBeGreaterThan(0)

        const closes = ours.map((watcher) => vi.spyOn(watcher, 'close'))

        await server.close()
        server = undefined

        // Read before any restore — `mockRestore` clears the recorded calls.
        const unclosed = closes.filter((spy) => spy.mock.calls.length === 0)
        expect(
          unclosed.length,
          `${unclosed.length} of ${ours.length} left open`,
        ).toBe(0)
      } finally {
        watchSpy.mockRestore()
      }
    },
    30000,
  )
})
