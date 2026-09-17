import type { Plugin } from 'vite'
import type { MockInstance } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as rollup from 'rollup'
import StyleDictionary from 'style-dictionary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StyleDictionaryConfigContext } from '../src/types.ts'

import packageJson from '../package.json' with { type: 'json' }
import rollupPlugin from '../src/rollup.ts'
import vitePlugin from '../src/vite.ts'
import { matchesWatchedFile } from '../src/watch-filter.ts'

interface BuildContext {
  addWatchFile: (id: string) => void

  // What rollup, rolldown and Vite all hand a hook, and webpack does not. Only
  // the cases asserting on watch mode set it; leaving it off is what a host
  // reporting nothing looks like.
  meta?: { watchMode?: boolean }
}

type PluginHook<A extends unknown[]> = (
  this: BuildContext,
  ...args: A
) => Promise<void> | void

// Rollup types every hook as `ObjectHook` — a union of a plain function and a
// `{ handler }` object — and neither member carries the stub `this` below. A
// predicate narrows that union to the callable form; a cast would claim the
// same thing without the compiler checking the call is possible at all.
function isPluginHook<A extends unknown[]>(
  hook: unknown,
): hook is PluginHook<A> {
  return typeof hook === 'function'
}

// Vite/Rollup normally provide the plugin-context `this` (with addWatchFile,
// etc.) when invoking a hook. To unit-test buildStart in isolation we bind a
// minimal stub context ourselves rather than spinning up a real dev server.
//
// Both callers return what the hook registered. The stub used to discard it,
// and that is why nothing here could see the plugin handing a watcher an
// unexpanded glob — which every watcher in play treats as a filename that does
// not exist.
const callBuildStart = async (plugin: Plugin) => {
  const watched: string[] = []
  const context: BuildContext = {
    addWatchFile: (id) => {
      watched.push(id)
    },
  }
  if (!isPluginHook<[]>(plugin.buildStart)) {
    throw new TypeError('buildStart is not a callable hook')
  }
  await plugin.buildStart.call(context)

  return watched
}

const callWatchChange = async (plugin: Plugin, id: string) => {
  const watched: string[] = []
  const context: BuildContext = {
    addWatchFile: (file) => {
      watched.push(file)
    },
  }
  if (!isPluginHook<[string]>(plugin.watchChange)) {
    throw new TypeError('watchChange is not a callable hook')
  }
  await plugin.watchChange.call(context, id)

  return watched
}

// Identity of a file on disk, not just its content. The atomic write renames a
// fresh file over the destination, so a build that rewrote it changes the
// inode — which a content comparison would miss when the bytes happen to be
// the same.
const identityOf = (file: string) => {
  const stats = fs.statSync(file)
  return `${stats.ino}:${stats.mtimeMs}`
}

describe('unplugin-style-dictionary (vite target)', () => {
  // A fixture directory per run, rather than one shared `temp-test-tokens` at
  // the repo root. Every path below is derived from it, and the whole suite
  // writes real files, so two vitest processes in the same checkout — a watch
  // run beside a one-shot run, an agent beside a human — otherwise delete and
  // truncate each other's fixtures and fail with ENOTEMPTY and ENOENT. Under
  // the OS temp directory a crashed run also leaves nothing untracked behind
  // in the working tree.
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-'),
  )
  const configFile = path.join(tempDir, 'sd.config.json')
  const tokenFile = path.join(tempDir, 'tokens.json')
  const outputFile = path.join(tempDir, 'vars.css')

  beforeEach(() => {
    // Setup mock directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // Write token file
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        color: {
          primary: {
            value: '#0070f3',
          },
        },
      }),
    )

    // Write Style Dictionary config file
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'vars.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokenFile.replace(/\\/g, '/')],
      }),
    )
  })

  afterEach(() => {
    // Cleanup files
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('compiles design tokens during buildStart', async () => {
    const plugin = vitePlugin({
      config: configFile,
      silent: true,
    })

    // Simulate configResolved hook
    if (isPluginHook<[Record<string, unknown>]>(plugin.configResolved)) {
      const context: BuildContext = { addWatchFile: () => {} }
      await plugin.configResolved.call(context, { root: process.cwd() })
    }

    await callBuildStart(plugin)

    // Verify output file was created and contains the correct CSS variable
    expect(fs.existsSync(outputFile)).toBe(true)
    const content = fs.readFileSync(outputFile, 'utf-8')
    expect(content).toContain('--color-primary: #0070f3;')
  })

  it('supports a custom format registered inside a config function', async () => {
    const customOutputFile = path.join(tempDir, 'custom-format.txt')

    const plugin = vitePlugin({
      config: () => {
        // Consumers use the function form of `config` to register a custom
        // format (e.g. StyleX or another framework's own token format)
        // before returning a config that references it by name.
        StyleDictionary.registerFormat({
          format: ({ dictionary }) =>
            dictionary.allTokens
              .map((token) => `${token.name}=${String(token.value)}`)
              .join('\n'),
          name: 'custom/plain-list',
        })

        return {
          platforms: {
            text: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [
                {
                  destination: 'custom-format.txt',
                  format: 'custom/plain-list',
                },
              ],
              transformGroup: 'css',
            },
          },
          source: [tokenFile.replace(/\\/g, '/')],
        }
      },
      silent: true,
    })

    await callBuildStart(plugin)

    expect(fs.existsSync(customOutputFile)).toBe(true)
    const content = fs.readFileSync(customOutputFile, 'utf-8')
    expect(content).toContain('color-primary=#0070f3')
  })

  it('does not warn or throw when a rebuild re-registers the same custom format', async () => {
    const repeatOutputFile = path.join(tempDir, 'repeat-format.txt')

    const plugin = vitePlugin({
      config: () => {
        // Every rebuild re-invokes this function, so a watch-triggered
        // rebuild registers 'custom/plain-list-repeat' again with the same
        // name. Style Dictionary silently overwrites existing hooks by
        // design (Register.js deletes the old one before merging in the
        // new one), so this must not warn or throw.
        StyleDictionary.registerFormat({
          format: ({ dictionary }) =>
            dictionary.allTokens
              .map((token) => `${token.name}=${String(token.value)}`)
              .join('\n'),
          name: 'custom/plain-list-repeat',
        })

        return {
          platforms: {
            text: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [
                {
                  destination: 'repeat-format.txt',
                  format: 'custom/plain-list-repeat',
                },
              ],
              transformGroup: 'css',
            },
          },
          source: [tokenFile.replace(/\\/g, '/')],
        }
      },
      silent: true,
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // Initial build, then a simulated watch-triggered rebuild.
      await callBuildStart(plugin)
      await callBuildStart(plugin)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    expect(fs.existsSync(repeatOutputFile)).toBe(true)
    const content = fs.readFileSync(repeatOutputFile, 'utf-8')
    expect(content).toContain('color-primary=#0070f3')
  })

  it('never exposes a partially written file to a concurrent reader', async () => {
    // The bug this pins: Style Dictionary used to write straight to the
    // destination, which truncates it first, so a consumer importing the
    // generated file mid-rebuild read a partial file and failed to parse it.
    // A single clean build proves nothing — the window is tens of
    // milliseconds — so this reads the file in a loop across many rebuilds.
    const concurrentTokenFile = path.join(tempDir, 'concurrent.tokens.json')
    const concurrentConfigFile = path.join(tempDir, 'concurrent.sd.config.json')
    const concurrentOutputFile = path.join(tempDir, 'concurrent.flat.json')

    // Every rebuild is one chance for the reader to catch a half-written
    // file, so this count is the test's sensitivity. Before the fix, every
    // single one of them was caught.
    const rebuilds = 20

    // Enough tokens that writing the output is slow enough to be caught
    // halfway: with a handful of tokens the write finishes within a single
    // tick and the race is invisible.
    //
    // One swatch varies, and the rebuild loop below alternates it. That is
    // load-bearing: a write whose bytes match the destination skips the
    // rename, so a loop of identical rebuilds would leave the very path this
    // test exists to cover unexercised and pass without touching it.
    const writeTokens = (marker: string) => {
      const color: Record<string, { value: string }> = {
        marker: { value: marker },
      }
      for (let index = 0; index < 4000; index++) {
        color[`swatch${index}`] = {
          value: `#${(index % 0xffffff).toString(16).padStart(6, '0')}`,
        }
      }

      fs.writeFileSync(concurrentTokenFile, JSON.stringify({ color }))
    }

    const markers = ['#000000', '#ffffff']
    writeTokens(markers[0])
    fs.writeFileSync(
      concurrentConfigFile,
      JSON.stringify({
        platforms: {
          json: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'concurrent.flat.json',
                format: 'json/flat',
              },
            ],
            transformGroup: 'js',
          },
        },
        source: [concurrentTokenFile.replace(/\\/g, '/')],
      }),
    )

    const plugin = vitePlugin({
      config: concurrentConfigFile,
      silent: true,
    })

    // Build once per marker so there is a complete file for each of the two
    // states the loop alternates between. Every read must land on one of them
    // exactly — anything else is a partial write.
    const complete: string[] = []
    for (const marker of markers) {
      writeTokens(marker)
      await callBuildStart(plugin)
      complete.push(fs.readFileSync(concurrentOutputFile, 'utf-8'))
    }
    expect(complete[0]).not.toBe(complete[1])

    const failures: string[] = []
    let reads = 0
    const state = { building: true }

    const reader = (async () => {
      while (state.building) {
        reads++

        let content: string
        try {
          content = fs.readFileSync(concurrentOutputFile, 'utf-8')
        } catch (err) {
          failures.push(
            `read failed: ${err instanceof Error ? err.message : String(err)}`,
          )
          await new Promise((resolve) => setImmediate(resolve))
          continue
        }

        if (!complete.includes(content)) {
          // Report it the way a consumer meets it — as a parse failure —
          // together with how much of the file this read actually saw.
          let reason = 'parsed, but the content differs'
          try {
            JSON.parse(content)
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err)
          }
          failures.push(
            `${reason} (read ${content.length} bytes, expected ${complete[0].length} or ${complete[1].length})`,
          )
        }

        // Yield so the rebuild below can make progress between reads.
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()

    for (let index = 0; index < rebuilds; index++) {
      writeTokens(markers[index % markers.length])
      await callBuildStart(plugin)
    }
    state.building = false
    await reader

    expect(failures).toEqual([])
    // Guards against the assertion above passing vacuously: the reader has to
    // have run often enough to land inside a rebuild rather than only before
    // the first one and after the last.
    expect(reads).toBeGreaterThan(rebuilds)
  }, 30000)

  // How many compiles actually ran, rather than how many were asked for.
  // Style Dictionary invokes a format once per generated file per build, so
  // with one file on one platform the count is the build count — which is
  // what a shared compile has to be measured in. Timestamps cannot say it: a
  // build that renders what is already there skips its own write.
  const countingConfig = (name: string, destination: string) => {
    const counter = { calls: 0 }

    const config = () => {
      StyleDictionary.registerFormat({
        format: ({ dictionary }) => {
          counter.calls++
          return dictionary.allTokens
            .map((token) => `${token.name}=${String(token.value)}`)
            .join('\n')
        },
        name,
      })

      return {
        platforms: {
          text: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [{ destination, format: name }],
            transformGroup: 'css',
          },
        },
        source: [tokenFile.replace(/\\/g, '/')],
      }
    }

    return { config, counter, output: path.join(tempDir, destination) }
  }

  it('compiles once when instances sharing a config start together', async () => {
    // The reported shape: one `vitest run` with two test projects and browser
    // mode stands up five Vite servers in one process, and the last two start
    // together — two `Compiling design tokens...` lines with no
    // `Compiled successfully!` between them. `hasCompiled` is closure state
    // per instance, so it sees none of it.
    //
    // Starting together is the part that needs a shared promise. Neither
    // instance has written a destination when the other begins, so there is
    // nothing on disk for an up-to-date check to compare against — #212's
    // check removes the repeats that arrive in turn, and cannot remove these.
    const { config, counter, output } = countingConfig(
      'custom/counting-together',
      'together.txt',
    )

    await Promise.all(
      Array.from({ length: 5 }, async () =>
        callBuildStart(vitePlugin({ config, silent: true })),
      ),
    )

    expect(counter.calls).toBe(1)
    expect(fs.existsSync(output)).toBe(true)
    expect(fs.readFileSync(output, 'utf-8')).toContain('color-primary=#0070f3')
  })

  it('reports the failure to every instance waiting on one compile', async () => {
    // An instance that waited on a compile which failed must not carry on as
    // though the tokens were written — the whole reason `failOnError`
    // defaults to stopping the build.
    const config = () => {
      StyleDictionary.registerFormat({
        format: () => {
          throw new Error('the format blew up')
        },
        name: 'custom/counting-shared-failure',
      })

      return {
        platforms: {
          text: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'shared-failure.txt',
                format: 'custom/counting-shared-failure',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokenFile.replace(/\\/g, '/')],
      }
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, async () =>
          callBuildStart(vitePlugin({ config, silent: true })),
        ),
      )

      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ])

      // Reported once rather than once per waiter, which is the other half of
      // sharing a compile: three instances failed, and the failure is one
      // event because the compile was.
      const failures = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('Compilation failed after'))
      expect(failures).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not share a compile between two different configurations', async () => {
    // The key carries the root and the resolved configurations, so one
    // process building two packages must not have the second wait on the
    // first and skip its own output.
    const first = countingConfig('custom/counting-first', 'first.txt')
    const second = countingConfig('custom/counting-second', 'second.txt')

    await Promise.all([
      callBuildStart(vitePlugin({ config: first.config, silent: true })),
      callBuildStart(vitePlugin({ config: second.config, silent: true })),
    ])

    expect(first.counter.calls).toBe(1)
    expect(second.counter.calls).toBe(1)
    expect(fs.existsSync(first.output)).toBe(true)
    expect(fs.existsSync(second.output)).toBe(true)
  })

  // A file-backed configuration in a directory of its own, so each test's
  // destinations and sources are unrelated to every other test's. A counting
  // format stands in for the compile, since what has to be observed is whether
  // `buildAllPlatforms` ran at all.
  const freshnessFixture = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(directory, { recursive: true })

    const counter = { calls: 0 }
    const format = `custom/freshness-${name}`
    const source = path.join(directory, 'tokens.json')
    const configPath = path.join(directory, 'sd.config.json')
    const output = path.join(directory, 'out.txt')

    StyleDictionary.registerFormat({
      format: ({ dictionary }) => {
        counter.calls++
        return dictionary.allTokens
          .map((token) => `${token.name}=${String(token.value)}`)
          .join('\n')
      },
      name: format,
    })

    const writeSource = (value: string) => {
      fs.writeFileSync(
        source,
        JSON.stringify({ color: { primary: { value } } }),
      )
    }

    const writeConfig = (extra: Record<string, unknown> = {}) => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          platforms: {
            text: {
              buildPath: directory.replace(/\\/g, '/') + '/',
              files: [{ destination: 'out.txt', format }],
              transformGroup: 'css',
              ...extra,
            },
          },
          source: [source.replace(/\\/g, '/')],
        }),
      )
    }

    writeSource('#0070f3')
    writeConfig()

    return {
      configPath,
      counter,
      directory,
      format,
      output,
      source,
      writeConfig,
      writeSource,
    }
  }

  it('skips a configuration whose output is newer than everything it reads', async () => {
    const fixture = freshnessFixture('up-to-date')

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )
    expect(fixture.counter.calls).toBe(1)
    const afterFirst = identityOf(fixture.output)

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )

    expect(fixture.counter.calls).toBe(1)
    expect(identityOf(fixture.output)).toBe(afterFirst)
  })

  it('skips a build whose output is written into a watched directory', async () => {
    // The layout that broke this, and the one AGENTS.md calls supported: the
    // `buildPath` sits inside the directory the `source` glob covers. Every
    // pattern's static parent is registered as a watch target so a token file
    // created later is noticed, and a directory's mtime moves whenever an
    // entry is renamed inside it — which is what the atomic write does to
    // every generated file. Reading that mtime as an input made the build the
    // newest thing the comparison could see, so nothing was ever up to date.
    const directory = path.join(tempDir, 'output-inside-source')
    fs.mkdirSync(directory, { recursive: true })

    const counter = { calls: 0 }
    const format = 'custom/freshness-in-place'
    StyleDictionary.registerFormat({
      format: ({ dictionary }) => {
        counter.calls++
        return dictionary.allTokens
          .map((token) => `${token.name}=${String(token.value)}`)
          .join('\n')
      },
      name: format,
    })

    fs.writeFileSync(
      path.join(directory, 'design.tokens.json'),
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    const configPath = path.join(tempDir, 'in-place.config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        platforms: {
          text: {
            // Into the very directory the glob below covers.
            buildPath: directory.replace(/\\/g, '/') + '/',
            files: [{ destination: 'out.txt', format }],
            transformGroup: 'css',
          },
        },
        source: [directory.replace(/\\/g, '/') + '/*.tokens.json'],
      }),
    )

    await callBuildStart(vitePlugin({ config: configPath, silent: true }))
    expect(counter.calls).toBe(1)

    await callBuildStart(vitePlugin({ config: configPath, silent: true }))

    expect(counter.calls).toBe(1)
  })

  it('says so rather than announcing a compile that did not happen', async () => {
    const fixture = freshnessFixture('up-to-date-log')

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(vitePlugin({ config: fixture.configPath }))

      const messages = logSpy.mock.calls.map((call) => String(call[0]))
      expect(
        messages.some((message) =>
          message.includes('Design tokens are already up to date'),
        ),
      ).toBe(true)
      expect(
        messages.some((message) => message.includes('Compiled successfully')),
      ).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  })

  it.each([
    {
      change: (fixture: ReturnType<typeof freshnessFixture>) => {
        fixture.writeSource('#ff0000')
      },
      label: 'a token source',
    },
    {
      change: (fixture: ReturnType<typeof freshnessFixture>) => {
        fixture.writeConfig({ prefix: 'kui' })
      },
      label: 'the config file itself',
    },
  ])('compiles again when $label has changed', async ({ change, label }) => {
    const fixture = freshnessFixture(`changed-${label.replaceAll(' ', '-')}`)

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )
    expect(fixture.counter.calls).toBe(1)

    change(fixture)

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )

    expect(fixture.counter.calls).toBe(2)
  })

  it('compiles again when a file named by `watch` has changed', async () => {
    // A consumer names an extra file because something in the build reads it.
    // Leaving it out of the comparison let a change to it be skipped over
    // while the watcher dutifully reported it.
    const fixture = freshnessFixture('watched-extra')
    const extra = path.join(fixture.directory, 'extra.txt')
    fs.writeFileSync(extra, 'first')

    const options = {
      config: fixture.configPath,
      silent: true,
      watch: extra,
    }

    await callBuildStart(vitePlugin(options))
    expect(fixture.counter.calls).toBe(1)

    fs.writeFileSync(extra, 'second')

    await callBuildStart(vitePlugin(options))

    expect(fixture.counter.calls).toBe(2)
  })

  it('never skips a platform that declares actions', async () => {
    // An action writes what no `destination` names, so there is nothing for
    // the freshness comparison to check and a skip would leave its work
    // undone.
    const fixture = freshnessFixture('with-actions')
    const actionOutput = path.join(fixture.directory, 'action-ran.txt')
    let actionRuns = 0

    StyleDictionary.registerAction({
      do: () => {
        actionRuns++
        fs.writeFileSync(actionOutput, String(actionRuns))
      },
      name: 'custom/freshness-action',
    })

    fixture.writeConfig({ actions: ['custom/freshness-action'] })

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )
    expect(actionRuns).toBe(1)

    await callBuildStart(
      vitePlugin({ config: fixture.configPath, silent: true }),
    )

    expect(actionRuns).toBe(2)
  })

  it('compiles every time when `cache` is false', async () => {
    const fixture = freshnessFixture('cache-off')
    const options = {
      cache: false,
      config: fixture.configPath,
      silent: true,
    }

    await callBuildStart(vitePlugin(options))
    expect(fixture.counter.calls).toBe(1)

    await callBuildStart(vitePlugin(options))

    // The counting format is the assertion, not the file on disk. A write
    // whose bytes match the destination already skips its own rename, so an
    // unchanged inode here would say nothing about whether the compile ran.
    expect(fixture.counter.calls).toBe(2)
  })

  it('skips an object configuration only once this process has built it', async () => {
    // An object has no file to stat, so the filesystem cannot tell an edited
    // one from the one that wrote the output beside it. The first build of a
    // process therefore always runs, and only a fingerprint recorded here
    // lets the second be skipped.
    const fixture = freshnessFixture('object-config')

    const configWith = (prefix: string | undefined) => ({
      platforms: {
        text: {
          buildPath: fixture.directory.replace(/\\/g, '/') + '/',
          files: [{ destination: 'out.txt', format: fixture.format }],
          prefix,
          transformGroup: 'css',
        },
      },
      source: [fixture.source.replace(/\\/g, '/')],
    })

    await callBuildStart(
      vitePlugin({ config: configWith(undefined), silent: true }),
    )
    expect(fixture.counter.calls).toBe(1)

    await callBuildStart(
      vitePlugin({ config: configWith(undefined), silent: true }),
    )
    expect(fixture.counter.calls).toBe(1)

    // A different object naming the same destination: the fingerprint moves,
    // so the output on disk can no longer be assumed to be the one this
    // configuration would write.
    await callBuildStart(
      vitePlugin({ config: configWith('kui'), silent: true }),
    )
    expect(fixture.counter.calls).toBe(2)
  })

  it('drops the size table, and reading every file to build it, when `report` is false', async () => {
    const fixture = freshnessFixture('report-off')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config: fixture.configPath, report: false }),
      )

      const messages = logSpy.mock.calls.map((call) => String(call[0]))

      // The table is gone.
      expect(messages.some((message) => message.includes('gzip:'))).toBe(false)

      // The progress lines are not, which is what separates this from
      // `logLevel`.
      expect(
        messages.some((message) => message.includes('Compiled successfully')),
      ).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('matchesWatchedFile matches config/token paths but not unrelated generated output', () => {
    const patterns = ['/project/tokens/*.tokens.json']

    expect(
      matchesWatchedFile('/project/tokens/design.tokens.json', patterns),
    ).toBe(true)
    // The exact shape of the original bug report: a generated file that sits
    // in the same directory as the watched glob, but doesn't match its
    // suffix, must not be treated as a watched source.
    expect(
      matchesWatchedFile('/project/tokens/design.tokens.stylex.ts', patterns),
    ).toBe(false)
  })

  // The hand-rolled matcher this replaces was wrong in both directions at
  // once, and the rows below are what both directions mean. Every expectation
  // is what glob answers, which is what Style Dictionary resolves its own
  // `source` and `include` patterns with — so a row that disagreed would be
  // the filter admitting something the build does not read, or rejecting
  // something it does.
  const matcherRows: Array<[pattern: string, file: string, matches: boolean]> =
    [
      // `**` matches zero directories. This row is the first of the two
      // failures: the README's own `tokens/**/*.json` never matched a token
      // file sitting directly in `tokens/`, so editing one rebuilt nothing.
      ['/p/tokens/**/*.json', '/p/tokens/design.json', true],
      ['/p/tokens/**/*.json', '/p/tokens/sub/design.json', true],
      ['/p/tokens/**/*.json', '/p/tokens/sub/deep/design.json', true],
      ['/p/tokens/**/*.json', '/p/tokens/design.css', false],
      // `*` stops at a separator, and the pattern is anchored at both ends.
      // The old regex branch mapped it to `.*` and tested it unanchored, so
      // all three of these were true.
      ['/p/tokens/*.json', '/p/tokens/design.json', true],
      ['/p/tokens/*.json', '/p/tokens/sub/design.json', false],
      ['/p/tokens/*.json', '/p/tokens/design.json.bak', false],
      ['/p/tokens/*.json', '/xx/p/tokens/design.json', false],
      // A directory pattern covers its own tree and nothing that merely
      // shares its prefix — the old branch stripped `/**` and let the
      // sibling directory in.
      ['/p/tokens/**', '/p/tokens/sub/design.json', true],
      ['/p/tokens/**', '/p/tokens-backup/design.ts', false],
      // An exact config path is not a prefix of a longer name.
      ['/p/sd.config.json', '/p/sd.config.json', true],
      ['/p/sd.config.json', '/p/sd.config.json.bak', false],
      // Brace sets and `?`: glob expands both, while the old matcher escaped
      // the braces into literals and never entered its glob branch at all for
      // a pattern whose only wildcard was `?`.
      ['/p/tokens/{color,size}.json', '/p/tokens/color.json', true],
      ['/p/tokens/{color,size}.json', '/p/tokens/space.json', false],
      ['/p/tokens/a?.json', '/p/tokens/a1.json', true],
      ['/p/tokens/a?.json', '/p/tokens/a12.json', false],
      // A dotfile is invisible to glob, so it is invisible here too. That is
      // the second reason this plugin's own atomic temporary file can never
      // match a watch pattern; the first is that it drops the destination's
      // extension.
      ['/p/tokens/*.json', '/p/tokens/.design.json', false],
      ['/p/tokens/*.css', '/p/tokens/.vars.4242.0.tmp', false],
    ]

  it.each(matcherRows)(
    'matchesWatchedFile: %s against %s is %s',
    (pattern, file, matches) => {
      expect(matchesWatchedFile(file, [pattern])).toBe(matches)
    },
  )

  it('matchesWatchedFile normalises a backslash-spelled path', () => {
    // chokidar reports native paths, so on Windows the file arrives with
    // backslashes while the watch list is POSIX. Both sides are normalised
    // before matching, which is what lets the two meet.
    expect(
      matchesWatchedFile('C:\\p\\tokens\\design.json', [
        'C:/p/tokens/**/*.json',
      ]),
    ).toBe(true)
  })

  it('rebuilds a token file sitting directly in a `**` source directory', async () => {
    // The end-to-end shape of the first failure, in the layout the README
    // documents: `source: ['tokens/**/*.json']` with the edited token file at
    // the top of that directory rather than in a subdirectory. Against a real
    // dev server this logged nothing at all and left the output untouched.
    const tokensDirectory = path.join(tempDir, 'glob-tokens')
    fs.mkdirSync(tokensDirectory, { recursive: true })

    const topLevelToken = path.join(tokensDirectory, 'base.json')
    const globConfigFile = path.join(tempDir, 'glob.sd.config.json')
    const globOutputFile = path.join(tempDir, 'glob-vars.css')

    fs.writeFileSync(
      topLevelToken,
      JSON.stringify({ color: { brand: { value: '#000000' } } }),
    )
    fs.writeFileSync(
      globConfigFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'glob-vars.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokensDirectory.replace(/\\/g, '/') + '/**/*.json'],
      }),
    )

    const plugin = vitePlugin({
      config: globConfigFile,
      silent: true,
    })

    await callBuildStart(plugin)
    expect(fs.readFileSync(globOutputFile, 'utf-8')).toContain(
      '--color-brand: #000000;',
    )

    fs.writeFileSync(
      topLevelToken,
      JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
    )
    await callWatchChange(plugin, topLevelToken)

    expect(fs.readFileSync(globOutputFile, 'utf-8')).toContain(
      '--color-brand: #ff0000;',
    )
  })

  // A `buildPath` inside a `source` directory is a supported layout, and its
  // output matches the very glob that produced it — so a correct matcher says
  // "watched source" about a file this plugin wrote, and every write triggers
  // the rebuild that makes the next one. Against a real dev server that is a
  // loop nothing breaks out of. Both layouts below are checked because the two
  // glob shapes reach the destination differently: `*.json` only matches
  // output written beside its sources, `**/*.json` also matches it a
  // directory below.
  it.each([
    {
      buildSubdirectory: '',
      id: 'beside',
      label: 'output written beside its own sources',
      sourceGlob: '*.json',
    },
    {
      buildSubdirectory: 'build',
      id: 'below',
      label: 'output written below its own sources',
      sourceGlob: '**/*.json',
    },
  ])(
    'never rebuilds on $label',
    async ({ buildSubdirectory, id, sourceGlob }) => {
      const tokensDirectory = path.join(tempDir, `self-trigger-${id}`)
      const buildDirectory = path.join(tokensDirectory, buildSubdirectory)
      fs.mkdirSync(buildDirectory, { recursive: true })

      const tokenSource = path.join(tokensDirectory, 'base.json')
      const selfConfigFile = path.join(
        tempDir,
        `self-trigger-${id}.config.json`,
      )
      const generated = path.join(buildDirectory, 'flat.json')
      const sourcePattern = `${tokensDirectory.replace(/\\\\/g, '/')}/${sourceGlob}`

      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#000000' } } }),
      )
      fs.writeFileSync(
        selfConfigFile,
        JSON.stringify({
          platforms: {
            json: {
              buildPath: buildDirectory.replace(/\\/g, '/') + '/',
              files: [
                {
                  destination: 'flat.json',
                  format: 'json/flat',
                },
              ],
              transformGroup: 'js',
            },
          },
          source: [sourcePattern],
        }),
      )

      const plugin = vitePlugin({
        config: selfConfigFile,
        silent: true,
      })

      await callBuildStart(plugin)

      // What makes the guard load-bearing: on the pattern alone this file is a
      // watched source, because it is output written under the glob that
      // produced it. Only subtracting what the build wrote tells the two apart.
      expect(
        matchesWatchedFile(generated.replace(/\\/g, '/'), [sourcePattern]),
      ).toBe(true)

      // Change the token source on disk without going through the plugin, so a
      // wrongly-triggered rebuild writes visibly different content.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )

      // Every generated file is written through a temporary file and renamed
      // over the destination, so a rebuild always lands a different inode.
      // Comparing that rather than the content is what makes this test unable
      // to pass vacuously: a rebuild that happened to write identical bytes
      // would still be caught.
      const inodeAfterBuild = fs.statSync(generated).ino

      await callWatchChange(plugin, generated)

      expect(fs.statSync(generated).ino).toBe(inodeAfterBuild)
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#000000')

      // The same watcher still rebuilds for a genuine token edit, so the guard
      // subtracts the plugin's own output rather than the whole directory.
      await callWatchChange(plugin, tokenSource)

      expect(fs.statSync(generated).ino).not.toBe(inodeAfterBuild)
      expect(fs.readFileSync(generated, 'utf-8')).toContain('#ff0000')
    },
  )

  // The existing fixtures keep the configuration and the tokens in one
  // directory, which is the single arrangement where the two bases coincide —
  // and why nothing here caught the plugin reading token patterns against the
  // configuration file's own directory while Style Dictionary read them
  // against the working directory.
  const writeNestedConfig = (name: string, source: string[]) => {
    const configDirectory = path.join(tempDir, name, 'config')
    fs.mkdirSync(configDirectory, { recursive: true })

    const nestedConfig = path.join(configDirectory, 'sd.config.json')
    fs.writeFileSync(
      nestedConfig,
      JSON.stringify({
        platforms: {
          css: {
            // Absolute: this fixture does not move the working directory, and
            // a relative build path would resolve against the repository.
            buildPath: path.join(tempDir, name).replace(/\\/g, '/') + '/',
            files: [{ destination: 'vars.css', format: 'css/variables' }],
            transformGroup: 'css',
          },
        },
        source,
      }),
    )

    return nestedConfig
  }

  it('builds and watches the same files for a nested config', async () => {
    // Relative token patterns only mean anything against a working directory,
    // so this one moves there — which is what a consumer running their
    // bundler from the project root is doing.
    const projectRoot = path.join(tempDir, 'nested-project')
    const tokensDirectory = path.join(projectRoot, 'tokens')
    fs.mkdirSync(tokensDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(tokensDirectory, 'color.json'),
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    const configDirectory = path.join(projectRoot, 'tokens', 'config')
    fs.mkdirSync(configDirectory, { recursive: true })
    const nestedConfig = path.join(configDirectory, 'sd.config.json')
    fs.writeFileSync(
      nestedConfig,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: 'build/',
            files: [{ destination: 'vars.css', format: 'css/variables' }],
            transformGroup: 'css',
          },
        },
        source: ['tokens/**/*.json'],
      }),
    )

    const originalCwd = process.cwd()
    process.chdir(projectRoot)
    try {
      // Every path below is derived from the working directory rather than
      // from `projectRoot`. On macOS the system temp directory is reached
      // through a symlink, so the two spell the same directory differently,
      // and a watcher reports whichever the host is actually standing in.
      const here = process.cwd()
      const generated = path.join(here, 'build', 'vars.css')
      const editedToken = path.join(here, 'tokens', 'color.json')

      const plugin = vitePlugin({
        config: 'tokens/config/sd.config.json',
        silent: true,
      })
      const watched = await callBuildStart(plugin)

      // The output lands where a reader of the configuration would expect.
      expect(fs.existsSync(generated)).toBe(true)
      expect(fs.readFileSync(generated, 'utf-8')).toContain(
        '--color-primary: #0070f3;',
      )

      // And every registered path exists, where the watch list used to name a
      // directory that never had.
      for (const registered of watched) {
        expect(fs.existsSync(registered)).toBe(true)
      }

      // The list is not merely plausible: an edit to a token the build read
      // is recognised as a source and rebuilds. Against a real dev server
      // this is exactly what stayed dead — the event arrived and the filter
      // rejected it, because the pattern it was tested against pointed
      // somewhere else.
      fs.writeFileSync(
        editedToken,
        JSON.stringify({ color: { primary: { value: '#ff0000' } } }),
      )
      await callWatchChange(plugin, editedToken)

      expect(fs.readFileSync(generated, 'utf-8')).toContain(
        '--color-primary: #ff0000;',
      )
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('looks a relative config path up under the root option', async () => {
    const nestedConfig = writeNestedConfig('root-option', [
      path.join(tempDir, 'tokens.json').replace(/\\/g, '/'),
    ])
    const relativeToRoot = path.relative(tempDir, nestedConfig)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config: relativeToRoot, root: tempDir, silent: true }),
      )

      // Without the option the path is read against the working directory and
      // the configuration is simply not there.
      const messages = errorSpy.mock.calls.map((call) => String(call[0]))
      expect(
        messages.filter((message) => message.includes('Failed to parse')),
      ).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('registers concrete paths for a glob source, never the pattern', async () => {
    // The shape README.md documents. Every watcher in play takes filenames:
    // Vite's chokidar and rollup's FileWatcher are built with
    // `disableGlobbing: true`, Vite's addWatchFile drops anything failing
    // `fs.existsSync`, and webpack never globs its fileDependencies — so a
    // pattern registered as-is is watched by nothing at all.
    const tokensDirectory = path.join(tempDir, 'glob-registration')
    const nestedDirectory = path.join(tokensDirectory, 'nested')
    fs.mkdirSync(nestedDirectory, { recursive: true })

    const topLevelToken = path.join(tokensDirectory, 'base.json')
    const nestedToken = path.join(nestedDirectory, 'more.json')
    const globConfigFile = path.join(tempDir, 'glob-registration.config.json')

    fs.writeFileSync(
      topLevelToken,
      JSON.stringify({ color: { one: { value: '#000000' } } }),
    )
    fs.writeFileSync(
      nestedToken,
      JSON.stringify({ color: { two: { value: '#111111' } } }),
    )
    fs.writeFileSync(
      globConfigFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'glob-registration.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokensDirectory.replace(/\\/g, '/') + '/**/*.json'],
      }),
    )

    const plugin = vitePlugin({
      config: globConfigFile,
      silent: true,
    })

    const watched = await callBuildStart(plugin)

    // Nothing registered may still be a pattern.
    expect(watched.filter((file) => /[!*?[\]{}]/.test(file))).toEqual([])

    // Every file the glob matches, at both depths.
    expect(watched).toContain(topLevelToken.replace(/\\/g, '/'))
    expect(watched).toContain(nestedToken.replace(/\\/g, '/'))

    // And the directory the glob is rooted at, which is what makes a token
    // file created later visible — watching only today's matches cannot see a
    // path that did not exist when the watcher was built.
    expect(watched).toContain(tokensDirectory.replace(/\\/g, '/'))

    // A config file is a literal path and reaches the watcher unchanged.
    expect(watched).toContain(globConfigFile.replace(/\\/g, '/'))
  })

  // A burst of watcher events is one logical change, and a dev server produces
  // bursts constantly: an editor's save-all, a branch checkout, a formatter
  // rewriting a directory. Each event used to start its own Style Dictionary
  // build, all of them overlapping.
  //
  // Counted through the plugin's own rebuild line rather than by instrumenting
  // anything, because that line is exactly what a consumer sees: before this,
  // one logical change printed it once per file.
  it('coalesces a burst of watcher events into one rebuild', async () => {
    const tokensDirectory = path.join(tempDir, 'burst')
    fs.mkdirSync(tokensDirectory, { recursive: true })

    const tokenFiles = ['one', 'two', 'three', 'four'].map((name, index) => {
      const burstToken = path.join(tokensDirectory, `${name}.json`)
      fs.writeFileSync(
        burstToken,
        JSON.stringify({ color: { [name]: { value: `#00000${index}` } } }),
      )
      return burstToken
    })

    const burstConfigFile = path.join(tempDir, 'burst.config.json')
    fs.writeFileSync(
      burstConfigFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'burst.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokensDirectory.replace(/\\/g, '/') + '/*.json'],
      }),
    )

    // Not silent: the rebuild line is what this counts.
    const plugin = vitePlugin({ config: burstConfigFile })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(plugin)
      logSpy.mockClear()

      // Four files rewritten as one logical change, then every trigger
      // delivered without waiting for the previous one — which is how a
      // watcher delivers them.
      for (const [index, burstToken] of tokenFiles.entries()) {
        fs.writeFileSync(
          burstToken,
          JSON.stringify({ color: { [`c${index}`]: { value: '#ff0000' } } }),
        )
      }
      await Promise.all(
        tokenFiles.map(async (burstToken) =>
          callWatchChange(plugin, burstToken),
        ),
      )

      expect(countRebuildLines(logSpy)).toBe(1)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('never has two Style Dictionary builds running at once', async () => {
    // `runBuilds` builds its configurations one after another so two
    // instances never write the same destination at once. Nothing serialised
    // the calls to it, which reintroduced the overlap one level up — so this
    // asserts the invariant where it was actually broken.
    const tokensDirectory = path.join(tempDir, 'serial')
    fs.mkdirSync(tokensDirectory, { recursive: true })

    const bulkToken = path.join(tokensDirectory, 'bulk.json')
    const serialConfigFile = path.join(tempDir, 'serial.config.json')
    fs.writeFileSync(
      bulkToken,
      JSON.stringify({ color: { brand: { value: '#000000' } } }),
    )
    fs.writeFileSync(
      serialConfigFile,
      JSON.stringify({
        platforms: {
          json: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'serial.flat.json',
                format: 'json/flat',
              },
            ],
            transformGroup: 'js',
          },
        },
        source: [bulkToken.replace(/\\/g, '/')],
      }),
    )

    const plugin = vitePlugin({
      config: serialConfigFile,
      silent: true,
    })
    await callBuildStart(plugin)

    let inside = 0
    let mostAtOnce = 0

    // The build is replaced by a stand-in of a known length rather than timed
    // as it is. A real build of a large dictionary is slow enough, but most of
    // that is synchronous, so a timer scheduled beside it does not reliably
    // fire before it finishes — which would leave this passing whether the
    // guard were there or not. What is under test is the scheduling, so the
    // window it schedules into is the thing worth controlling.
    const BUILD_MS = 300
    const buildSpy = vi
      .spyOn(StyleDictionary.prototype, 'buildAllPlatforms')
      .mockImplementation(async function (this: StyleDictionary) {
        inside++
        mostAtOnce = Math.max(mostAtOnce, inside)
        try {
          await settle(BUILD_MS)
          return this
        } finally {
          inside--
        }
      })

    try {
      // The token is really rewritten before each trigger, rather than the
      // hook being told about a change that never happened. Both are now
      // load-bearing: a configuration whose output is newer than everything
      // it reads is skipped, so a trigger for an untouched file reaches no
      // build at all and the count below would be zero.
      //
      // Past the debounce, so the two are not merged into one rebuild, and
      // well inside the build above, so without the in-flight chain the
      // second starts beside the first.
      fs.writeFileSync(
        bulkToken,
        JSON.stringify({ color: { brand: { value: '#111111' } } }),
      )
      const first = callWatchChange(plugin, bulkToken)
      await settle(150)
      fs.writeFileSync(
        bulkToken,
        JSON.stringify({ color: { brand: { value: '#222222' } } }),
      )
      const second = callWatchChange(plugin, bulkToken)
      await Promise.all([first, second])

      expect(mostAtOnce).toBe(1)
      // Not a vacuous pass: both triggers really did reach a build, so the
      // one-at-a-time result is serialisation rather than coalescing.
      expect(buildSpy.mock.calls.length).toBe(2)
    } finally {
      buildSpy.mockRestore()
    }
  }, 30000)

  // A configuration that cannot be loaded has to come out of the plugin as a
  // logged failure. Until the instance was constructed with `init: false`, the
  // constructor's own fire-and-forget `init()` rejected a promise nothing
  // held: the host died with a raw stack, or — where something had installed
  // an `unhandledRejection` handler — `buildStart` simply never settled.
  it.each([
    {
      contents: undefined,
      failsWith: /ENOENT|no such file/i,
      id: 'missing',
      label: 'a config path that does not exist',
    },
    {
      contents: '{ "platforms": {',
      failsWith: /JSON5|invalid/i,
      id: 'malformed',
      label: 'a config whose JSON is half-written',
    },
    {
      contents: 'module.exports = { source: [] }',
      failsWith: /JSON5|invalid/i,
      id: 'cjs',
      label: 'a .cjs config, which is not a Style Dictionary format',
    },
  ])(
    'reports $label rather than crashing the host',
    async ({ contents, failsWith, id }) => {
      const brokenConfigFile = path.join(
        tempDir,
        `broken-${id}.${id === 'cjs' ? 'cjs' : 'json'}`,
      )
      if (contents !== undefined) fs.writeFileSync(brokenConfigFile, contents)

      const rejections: unknown[] = []
      const recordRejection = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on('unhandledRejection', recordRejection)

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Style Dictionary warns on its own account for an extension it does
      // not recognise — `.cjs` here — and that goes to `console.warn`, which
      // the error spy above never covered.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        // `'warn'` rather than `'silent'`: it drops the plugin's own progress
        // lines, which are noise in a test that exists to provoke a failure,
        // and leaves what Style Dictionary reports exactly as it was. A
        // failure is reported at every level, so the spy below still sees the
        // one this asserts on.
        const plugin = vitePlugin({
          config: brokenConfigFile,
          logLevel: 'warn',
        })

        // Settling at all is half the assertion — this is what used to hang —
        // and rejecting is the other half, since a configuration that cannot
        // be loaded must not leave the host building.
        await expect(callBuildStart(plugin)).rejects.toThrow(failsWith)

        // A rejection is reported a tick after it is orphaned, so give it one.
        await settle(50)
        expect(rejections).toEqual([])

        const messages = errorSpy.mock.calls.map((call) => String(call[0]))
        expect(
          messages.some((message) =>
            message.includes('Compilation failed after'),
          ),
        ).toBe(true)
      } finally {
        errorSpy.mockRestore()
        warnSpy.mockRestore()
        process.off('unhandledRejection', recordRejection)
      }
    },
    15000,
  )

  // A token set with a broken reference compiles to nothing usable, and the
  // plugin used to log that and return. Every target then exited 0 and shipped
  // whatever the previous run had written.
  const writeBrokenReferenceFixture = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(directory, { recursive: true })

    const brokenToken = path.join(directory, 'color.json')
    const brokenConfig = path.join(tempDir, `${name}.config.json`)

    fs.writeFileSync(
      brokenToken,
      JSON.stringify({ color: { primary: { value: '{color.nothing.here}' } } }),
    )
    fs.writeFileSync(
      brokenConfig,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: `${name}.css`,
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [brokenToken.replace(/\\/g, '/')],
      }),
    )

    return { config: brokenConfig, token: brokenToken }
  }

  it('fails the one-shot build when the token set is broken', async () => {
    const { config } = writeBrokenReferenceFixture('broken-reference')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        callBuildStart(vitePlugin({ config, silent: true })),
      ).rejects.toThrow(/reference/i)

      // Reported as well as thrown, and `silent` does not hide it: a build
      // that ships nothing usable must not also say nothing.
      const messages = errorSpy.mock.calls.map((call) => String(call[0]))
      expect(
        messages.some((message) =>
          message.includes('Compilation failed after'),
        ),
      ).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('lets a dev server survive the same broken token set', async () => {
    // The default is `'build'`, so a watch-triggered rebuild reports and
    // carries on. A half-typed token file mid-session should not take the
    // server down with it.
    const { config, token } = writeBrokenReferenceFixture('broken-on-rebuild')

    // Start from a token set that compiles, so the failure is introduced by
    // the edit rather than present from the beginning.
    fs.writeFileSync(
      token,
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    const plugin = vitePlugin({ config, silent: true })
    await callBuildStart(plugin)

    fs.writeFileSync(
      token,
      JSON.stringify({ color: { primary: { value: '{color.nothing.here}' } } }),
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(callWatchChange(plugin, token)).resolves.toBeDefined()

      const messages = errorSpy.mock.calls.map((call) => String(call[0]))
      expect(
        messages.some((message) =>
          message.includes('Compilation failed after'),
        ),
      ).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it.each([
    { failOnError: false as const, label: 'false' },
    { failOnError: 'serve' as const, label: "'serve'" },
  ])(
    'does not fail the one-shot build under $label',
    async ({ failOnError }) => {
      const { config } = writeBrokenReferenceFixture(`tolerant-${failOnError}`)

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(
          callBuildStart(vitePlugin({ config, failOnError, silent: true })),
        ).resolves.toBeDefined()
      } finally {
        errorSpy.mockRestore()
      }
    },
  )

  it('initialises Style Dictionary once, so a preprocessor runs once', async () => {
    // `init()` is `extend()` with `mutateOriginal`, so constructing and then
    // extending loaded the configuration and combined every source twice.
    // Counting a consumer's own preprocessor is the cheapest way to see it:
    // it ran once per initialisation.
    let preprocessorRuns = 0

    const plugin = vitePlugin({
      config: () => {
        StyleDictionary.registerPreprocessor({
          name: 'count-runs',
          preprocessor: (dictionary) => {
            preprocessorRuns++
            return dictionary
          },
        })

        return {
          platforms: {
            css: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [
                {
                  destination: 'preprocessor-count.css',
                  format: 'css/variables',
                },
              ],
              transformGroup: 'css',
            },
          },
          preprocessors: ['count-runs'],
          source: [tokenFile.replace(/\\/g, '/')],
        }
      },
      silent: true,
    })

    await callBuildStart(plugin)

    expect(preprocessorRuns).toBe(1)
  })

  // A filter that matches nothing is the sharpest case: Style Dictionary
  // writes no file and says so, and that sentence used to be the one thing the
  // plugin suppressed — so a build that produced nothing reported success.
  const unmatchableFilterConfig = (destination: string) => ({
    log: { verbosity: 'verbose' as const },
    platforms: {
      css: {
        buildPath: tempDir.replace(/\\/g, '/') + '/',
        files: [
          {
            destination,
            filter: () => false,
            format: 'css/variables',
          },
        ],
        transformGroup: 'css',
      },
    },
    source: [tokenFile.replace(/\\/g, '/')],
  })

  it("lets the configuration's own log.verbosity through", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config: unmatchableFilterConfig('unmatched.css') }),
      )

      const said = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(said).toContain('No tokens for unmatched.css. File not created.')
    } finally {
      logSpy.mockRestore()
    }

    // And the file really was not written, so the message is the only way a
    // consumer would know.
    expect(fs.existsSync(path.join(tempDir, 'unmatched.css'))).toBe(false)
  })

  it.each([
    { label: 'logLevel: silent', options: { logLevel: 'silent' as const } },
    { label: 'silent: true', options: { silent: true } },
  ])('says nothing under $label', async ({ options }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({
          config: unmatchableFilterConfig('quiet.css'),
          ...options,
        }),
      )

      // Neither Style Dictionary's warning nor the plugin's own lines, even
      // though the configuration asked for verbose.
      expect(logSpy.mock.calls).toEqual([])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('reports a failure even at the quietest level', async () => {
    const { config } = writeBrokenReferenceFixture('quiet-failure')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config, failOnError: false, logLevel: 'silent' }),
      )

      expect(logSpy.mock.calls).toEqual([])
      const messages = errorSpy.mock.calls.map((call) => String(call[0]))
      expect(
        messages.some((message) =>
          message.includes('Compilation failed after'),
        ),
      ).toBe(true)
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('under warn, says what Style Dictionary says and nothing of its own', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({
          config: unmatchableFilterConfig('warn-level.css'),
          logLevel: 'warn',
        }),
      )

      const said = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(said).toContain('No tokens for warn-level.css. File not created.')

      // The plugin's own progress lines are what this level drops.
      expect(said).not.toContain('Compiling design tokens')
      expect(said).not.toContain('Compiled successfully')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('keeps Style Dictionary quiet under silent', async () => {
    // Style Dictionary prints a collision warning itself, and the first of the
    // two initialisations ran at default verbosity — so its warnings reached
    // the console whatever this plugin was asked for. Pinning silence here
    // pins the single-initialisation shape indirectly: that line can only come
    // from a pass that is not silent.
    const collidingDirectory = path.join(tempDir, 'collision')
    fs.mkdirSync(collidingDirectory, { recursive: true })
    for (const [index, name] of ['one', 'two'].entries()) {
      fs.writeFileSync(
        path.join(collidingDirectory, `${name}.json`),
        JSON.stringify({ color: { brand: { value: `#00000${index}` } } }),
      )
    }

    const collisionConfigFile = path.join(tempDir, 'collision.config.json')
    fs.writeFileSync(
      collisionConfigFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'collision.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [collidingDirectory.replace(/\\/g, '/') + '/*.json'],
      }),
    )

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config: collisionConfigFile, silent: true }),
      )

      const said = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((call) =>
        String(call[0]),
      )
      expect(said.filter((message) => message.includes('collision'))).toEqual(
        [],
      )
      expect(said).toEqual([])
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('watchChange does not rebuild when the changed file is not a watched source', async () => {
    const plugin = vitePlugin({
      config: configFile,
      silent: true,
    })

    await callBuildStart(plugin)
    const beforeContent = fs.readFileSync(outputFile, 'utf-8')

    // Change the token source on disk without going through the plugin, so
    // a wrongly-triggered rebuild would produce visibly different output —
    // a false negative (rebuild ran but happened to write identical
    // content) is impossible here.
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        color: {
          primary: {
            value: '#ff0000',
          },
        },
      }),
    )

    // This is the exact shape of the reported bug: the plugin's own
    // generated output is part of the host bundler's module graph (real
    // code imports it), so a naive watchChange implementation reacts to it
    // "changing" — which every regenerate does — and rebuilds forever.
    // outputFile is not part of `source`/`include` in the fixture config,
    // so this must be a no-op regardless of what changed on disk elsewhere.
    await callWatchChange(plugin, outputFile)

    expect(fs.readFileSync(outputFile, 'utf-8')).toBe(beforeContent)
  })

  it('watchChange rebuilds when the changed file is a watched token source', async () => {
    const plugin = vitePlugin({
      config: configFile,
      silent: true,
    })

    await callBuildStart(plugin)

    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        color: {
          primary: {
            value: '#ff0000',
          },
        },
      }),
    )

    await callWatchChange(plugin, tokenFile)

    const content = fs.readFileSync(outputFile, 'utf-8')
    expect(content).toContain('--color-primary: #ff0000;')
  })

  // Nothing a consumer could hook into existed before these: formatting the
  // generated files, type-checking them or telling something else they had
  // landed all meant forking the plugin or bolting a second watcher onto the
  // output directory. The data the hooks carry was already being computed for
  // the size table and then dropped.
  describe('the build hooks', () => {
    it('calls onBuildStart and onBuildEnd once, with every generated file', async () => {
      const started: number[] = []
      const ended: Array<{ duration: number; files: string[] }> = []

      await callBuildStart(
        vitePlugin({
          config: configFile,
          logLevel: 'silent',
          onBuildEnd: (files, durationMs) => {
            ended.push({ duration: durationMs, files })
          },
          onBuildStart: () => {
            started.push(Date.now())
          },
        }),
      )

      expect(started).toHaveLength(1)
      expect(ended).toHaveLength(1)

      // The absolute path of what was actually written, not a relative one and
      // not a directory.
      expect(ended[0]?.files).toEqual([outputFile])
      expect(fs.existsSync(outputFile)).toBe(true)

      // A duration rather than a placeholder. Nothing here pins how long a
      // build takes, only that the number describes one.
      expect(ended[0]?.duration).toBeTypeOf('number')
      expect(ended[0]?.duration).toBeGreaterThanOrEqual(0)
    })

    it('hands a watch rebuild the same file list, not an empty one', async () => {
      // This is the case the collection used to be gated against. `generatedFiles`
      // was populated only when no `context` was passed, and a rebuild passes
      // one — so a post-processing hook, which is the whole point of `onBuildEnd`,
      // would have seen every file on the first build and nothing on any edit
      // after it.
      const ended: string[][] = []

      const plugin = vitePlugin({
        config: configFile,
        logLevel: 'silent',
        onBuildEnd: (files) => {
          ended.push(files)
        },
      })

      await callBuildStart(plugin)
      expect(ended).toHaveLength(1)
      expect(ended[0]).toEqual([outputFile])

      fs.writeFileSync(
        tokenFile,
        JSON.stringify({ color: { primary: { value: '#ff0000' } } }),
      )
      await callWatchChange(plugin, tokenFile)

      expect(ended).toHaveLength(2)
      expect(ended[1]).toEqual([outputFile])
      expect(fs.readFileSync(outputFile, 'utf-8')).toContain(
        '--color-primary: #ff0000;',
      )
    })

    it('calls onBuildError with what was thrown, before failOnError decides', async () => {
      // Left at its default, so this build throws. The hook still has to have
      // fired: it is called ahead of that decision, because under a dev server
      // the same failure does not throw at all and a hook that waited for one
      // would be silent on exactly the builds a consumer is watching.
      fs.writeFileSync(
        tokenFile,
        JSON.stringify({ color: { primary: { value: '{color.nope.value}' } } }),
      )

      const failures: unknown[] = []
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await expect(
          callBuildStart(
            vitePlugin({
              config: configFile,
              logLevel: 'silent',
              onBuildError: (error) => {
                failures.push(error)
              },
            }),
          ),
        ).rejects.toThrow('Reference Errors')

        expect(failures).toHaveLength(1)

        // Narrowed rather than asserted, so the compiler checks the reach into
        // `.message` instead of taking its word for it.
        const [failure] = failures
        if (!(failure instanceof Error)) {
          throw new TypeError('onBuildError was handed a non-Error')
        }
        expect(failure.message).toContain('Reference Errors')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Compilation failed'),
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('reports a hook that throws and builds anyway', async () => {
      // A post-processing step that fails must not undo a compile the plugin
      // itself completed. The files are written and correct; the hook is the
      // thing that went wrong, and it says so.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await callBuildStart(
          vitePlugin({
            config: configFile,
            logLevel: 'silent',
            onBuildEnd: () => {
              throw new Error('prettier fell over')
            },
          }),
        )

        expect(fs.existsSync(outputFile)).toBe(true)
        expect(fs.readFileSync(outputFile, 'utf-8')).toContain(
          '--color-primary: #0070f3;',
        )

        // Named as the hook's failure rather than the build's, so it cannot be
        // read as the compile having gone wrong.
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('The onBuildEnd hook threw'),
        )
        expect(errorSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('Compilation failed'),
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('reports a hook that rejects rather than leaving it unhandled', async () => {
      // The quieter of the two failure modes. The return value is deliberately
      // not awaited, so a rejection has nothing holding it and reaches the host
      // as an unhandled rejection — which under Node's default exits the
      // process, killing a dev server from inside a hook meant to reformat a
      // file.
      const unhandled: unknown[] = []
      const record = (reason: unknown) => {
        unhandled.push(reason)
      }

      // Vitest installs its own handler and fails the run on an unhandled
      // rejection, so this asserts on Node's event rather than on the process
      // surviving — the run would already be over by then.
      process.on('unhandledRejection', record)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await callBuildStart(
          vitePlugin({
            config: configFile,
            logLevel: 'silent',
            // The realistic shape: a consumer's post-processing step written
            // `async`, which fails.
            onBuildEnd: async () => {
              await Promise.resolve()
              throw new Error('async step fell over')
            },
          }),
        )

        // Node emits the event after the microtask queue drains, so the check
        // waits out a macrotask rather than reading it on the same tick.
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(unhandled).toEqual([])
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('The onBuildEnd hook rejected'),
        )
        expect(fs.existsSync(outputFile)).toBe(true)
      } finally {
        errorSpy.mockRestore()
        process.off('unhandledRejection', record)
      }
    })
  })

  // Every line the plugin wrote carried hardcoded escapes, and nothing read
  // `NO_COLOR`, `FORCE_COLOR` or `isTTY` — so a redirected build, a CI log and
  // a `NO_COLOR=1` run all got them anyway, while the host's own lines beside
  // them came out clean.
  describe('when the terminal says what it wants', () => {
    const ESCAPE = '['

    // The decision is taken when the plugin is constructed and held for its
    // life, so the environment has to be in place before the factory runs —
    // which is why each case builds its own plugin rather than sharing one.
    const captureBuild = async (
      env: Record<string, string | undefined>,
      isTTY: boolean,
    ) => {
      const previousEnv = { ...process.env }
      const previousTTY = process.stdout.isTTY

      const written: string[] = []
      const collect = (...call: unknown[]) => {
        written.push(String(call[0]))
      }
      const logSpy = vi.spyOn(console, 'log').mockImplementation(collect)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(collect)

      try {
        for (const key of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) {
          delete process.env[key]
        }
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        process.stdout.isTTY = isTTY

        // No `silent`, because the progress lines and the size table are two
        // thirds of what carried escapes.
        await callBuildStart(vitePlugin({ config: configFile }))
      } finally {
        process.stdout.isTTY = previousTTY
        process.env = previousEnv
        logSpy.mockRestore()
        errorSpy.mockRestore()
      }

      return written
    }

    it('writes no escapes under NO_COLOR, including in the size table', async () => {
      const written = await captureBuild({ NO_COLOR: '1' }, true)

      // The table is the half a check on the progress lines alone would miss:
      // it is built in a different function with its own escapes.
      expect(written.some((line) => line.includes('gzip:'))).toBe(true)
      expect(written.some((line) => line.includes(ESCAPE))).toBe(false)
    })

    it('honours FORCE_COLOR on something that is not a terminal', async () => {
      // The case a single conjunction gets wrong. Written as
      // `!NO_COLOR && FORCE_COLOR !== '0' && stream.isTTY`, the TTY check has
      // the last word and answers `false` — so `FORCE_COLOR=1` in CI, which is
      // the only job that variable has, would do nothing at all.
      const written = await captureBuild({ FORCE_COLOR: '1' }, false)

      expect(written.some((line) => line.includes(ESCAPE))).toBe(true)
    })

    it('lets NO_COLOR win over FORCE_COLOR', async () => {
      const written = await captureBuild(
        { FORCE_COLOR: '1', NO_COLOR: '1' },
        true,
      )

      expect(written.some((line) => line.includes(ESCAPE))).toBe(false)
    })

    it('writes no escapes when FORCE_COLOR is 0 on a terminal', async () => {
      const written = await captureBuild({ FORCE_COLOR: '0' }, true)

      expect(written.some((line) => line.includes(ESCAPE))).toBe(false)
    })

    it('writes no escapes when nothing is a terminal', async () => {
      const written = await captureBuild({}, false)

      expect(written.some((line) => line.includes(ESCAPE))).toBe(false)
    })

    it('writes escapes on a plain terminal', async () => {
      const written = await captureBuild({}, true)

      expect(written.some((line) => line.includes(ESCAPE))).toBe(true)
    })

    it('writes no escapes on a terminal that says it is dumb', async () => {
      const written = await captureBuild({ TERM: 'dumb' }, true)

      expect(written.some((line) => line.includes(ESCAPE))).toBe(false)
    })
  })

  // Nothing the plugin said went through the bundler: `this.warn`, `this.error`
  // and `config.logger` appear nowhere in the source it was written against, so
  // under webpack the messages were absent from `stats.toJson()` and everything
  // built on it, and under Vite they bypassed `customLogger` and `clearScreen`.
  describe('when the host offers somewhere to put a message', () => {
    // A richer plugin context than `callBuildStart` binds. The stub there
    // carries `addWatchFile` and nothing else on purpose — it is what a hook
    // sees when no host has claimed the messages, and the console fallback is
    // what this contrasts against.
    const callWithContext = async (
      plugin: Plugin,
      context: Record<string, unknown>,
    ) => {
      if (!isPluginHook<[]>(plugin.buildStart)) {
        throw new TypeError('buildStart is not a callable hook')
      }

      // Assigned to the declared context type first, so the extra channels
      // ride along as a widened object rather than through a cast.
      const bound: BuildContext = { addWatchFile: () => {}, ...context }
      await plugin.buildStart.call(bound)
    }

    it('reports through the plugin context rather than the console', async () => {
      const warned: string[] = []
      const infos: string[] = []
      const fatal: string[] = []

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      try {
        fs.writeFileSync(
          tokenFile,
          JSON.stringify({
            color: { primary: { value: '{color.nope.value}' } },
          }),
        )

        await expect(
          callWithContext(
            vitePlugin({ config: configFile, failOnError: false }),
            {
              error: (message: string) => fatal.push(message),
              info: (message: string) => infos.push(message),
              warn: (message: string) => warned.push(message),
            },
          ),
        ).resolves.toBeUndefined()

        // The failure reached the host.
        expect(
          warned.some((message) => message.includes('Compilation failed')),
        ).toBe(true)

        // **And never through `this.error`.** Rollup's aborts the bundle, so a
        // report sent that way would stop every build that reported anything
        // and take the decision `failOnError` exists to make — measured: a
        // `buildStart` calling it ends the run with `THREW: [plugin …]`.
        expect(fatal).toEqual([])

        // The progress lines went to the host too, so the console saw none of
        // it — a message delivered twice is worse than one delivered once.
        expect(infos.some((message) => message.includes('Compiling'))).toBe(
          true,
        )
        expect(errorSpy).not.toHaveBeenCalled()
        expect(logSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
        logSpy.mockRestore()
      }
    })

    it('falls back to the console when the context offers nothing', async () => {
      // The unit-test stub, and any host whose context carries no channels.
      // Feature-detected rather than assumed: calling `this.warn` against a
      // context without one throws, and the failure reads as a plugin bug.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        fs.writeFileSync(
          tokenFile,
          JSON.stringify({
            color: { primary: { value: '{color.nope.value}' } },
          }),
        )

        await callBuildStart(
          vitePlugin({
            config: configFile,
            failOnError: false,
            logLevel: 'silent',
          }),
        )

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Compilation failed'),
        )
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  // The function form of `config` took no arguments, so a consumer could not
  // vary what got built by what the bundler was doing — no way to skip an
  // expensive platform under the dev server and build it on `vite build`, and
  // no way to branch on mode. Reading `process.env` and hoping was the only
  // workaround.
  describe('the context a config function is handed', () => {
    it('reports a one-shot build', async () => {
      const seen: StyleDictionaryConfigContext[] = []

      await callBuildStart(
        vitePlugin({
          config: (context) => {
            seen.push(context)

            return {
              platforms: {
                css: {
                  buildPath: tempDir.replace(/\\/g, '/') + '/',
                  files: [{ destination: 'vars.css', format: 'css/variables' }],
                  transformGroup: 'css',
                },
              },
              source: [tokenFile.replace(/\\/g, '/')],
            }
          },
          logLevel: 'silent',
        }),
      )

      expect(seen).toHaveLength(1)
      expect(seen[0]?.command).toBe('build')

      // Derived from `command` rather than invented: the unit-test context is
      // not Vite's, so no host reported a mode, and `production` is the answer
      // Vite itself gives a build.
      expect(seen[0]?.mode).toBe('production')

      // The stub context carries no `meta`, which is also what a host offering
      // no watch mode looks like.
      expect(seen[0]?.watch).toBe(false)

      expect(fs.existsSync(outputFile)).toBe(true)
    })

    it('reports watch mode when the host says so', async () => {
      // `meta.watchMode` is what rollup, rolldown and Vite all carry, and the
      // reason `watch` is read from the host rather than inferred from
      // `command`: `rollup --watch` both watches and builds.
      const seen: StyleDictionaryConfigContext[] = []

      const plugin = vitePlugin({
        config: (context) => {
          seen.push(context)

          return {
            platforms: {
              css: {
                buildPath: tempDir.replace(/\\/g, '/') + '/',
                files: [{ destination: 'vars.css', format: 'css/variables' }],
                transformGroup: 'css',
              },
            },
            source: [tokenFile.replace(/\\/g, '/')],
          }
        },
        logLevel: 'silent',
      })

      if (!isPluginHook<[]>(plugin.buildStart)) {
        throw new TypeError('buildStart is not a callable hook')
      }

      const bound: BuildContext = {
        addWatchFile: () => {},
        meta: { watchMode: true },
      }
      await plugin.buildStart.call(bound)

      expect(seen).toHaveLength(1)
      expect(seen[0]?.watch).toBe(true)

      // Still a build: watching and serving are different questions.
      expect(seen[0]?.command).toBe('build')
    })

    it('still accepts a function that takes no arguments', async () => {
      // The compatibility claim, exercised rather than asserted about:
      // TypeScript assigns a function of fewer parameters to a type declaring
      // more, and JavaScript ignores the extra argument. This case fails to
      // compile if that ever stops being true.
      let called = 0

      await callBuildStart(
        vitePlugin({
          config: () => {
            called++

            return {
              platforms: {
                css: {
                  buildPath: tempDir.replace(/\\/g, '/') + '/',
                  files: [{ destination: 'vars.css', format: 'css/variables' }],
                  transformGroup: 'css',
                },
              },
              source: [tokenFile.replace(/\\/g, '/')],
            }
          },
          logLevel: 'silent',
        }),
      )

      expect(called).toBe(1)
      expect(fs.readFileSync(outputFile, 'utf-8')).toContain(
        '--color-primary: #0070f3;',
      )
    })
  })

  // A `source` matching no files was not an error anywhere in this stack.
  // Style Dictionary wrote the destination with no custom properties in it,
  // printed its usual tick at every verbosity, and returned — so a token file
  // deleted mid-session took the generated output down with it and reported
  // `Rebuilt design tokens` while doing it, and a `source` matching nothing
  // shipped an empty stylesheet from a build that exited 0.
  describe('when a configuration resolves no tokens', () => {
    it('keeps the previous output and reports, rather than emptying it', async () => {
      // `cache: false` because the up-to-date check would otherwise skip this
      // configuration entirely — with its only source gone, nothing it reads
      // is newer than the output, so the destination survives by accident
      // rather than by this check. Turning the cache off is what puts the
      // compile back in the path so the check is what saves the file.
      //
      // `failOnError: false` so the rebuild reports and continues, which is
      // what a dev server does; the throwing half is the next case.
      const plugin = vitePlugin({
        cache: false,
        config: configFile,
        failOnError: false,
        logLevel: 'silent',
      })

      await callBuildStart(plugin)
      const firstBuild = fs.readFileSync(outputFile, 'utf-8')
      expect(firstBuild).toContain('--color-primary: #0070f3;')

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        fs.rmSync(tokenFile)
        await callWatchChange(plugin, tokenFile)

        // The output is byte-for-byte what the good build wrote. Before this,
        // it was `:root {\n\n}`.
        expect(fs.readFileSync(outputFile, 'utf-8')).toBe(firstBuild)

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('resolved no tokens'),
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('fails a one-shot build rather than shipping an empty file', async () => {
      // `failOnError` left at its default, which throws on the compile in
      // `buildStart`. The point is that this is a *build*: it used to exit 0.
      const barren = path.join(tempDir, 'barren.config.json')
      const missing = path.join(tempDir, 'nowhere', '**', '*.json')
      fs.writeFileSync(
        barren,
        JSON.stringify({
          platforms: {
            css: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [{ destination: 'empty.css', format: 'css/variables' }],
              transformGroup: 'css',
            },
          },
          source: [missing.replace(/\\/g, '/')],
        }),
      )

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(
          callBuildStart(vitePlugin({ config: barren, logLevel: 'silent' })),
        ).rejects.toThrow('resolved no tokens')

        // Nothing was written, so there is no empty stylesheet to ship.
        expect(fs.existsSync(path.join(tempDir, 'empty.css'))).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('names the pattern that matched nothing', async () => {
      // The token count says a configuration is empty; only the patterns say
      // why. A message naming neither leaves a consumer to guess which of
      // several sources moved.
      const barren = path.join(tempDir, 'named.config.json')
      const missing = (path.join(tempDir, 'gone') + '/**/*.json').replace(
        /\\/g,
        '/',
      )
      fs.writeFileSync(
        barren,
        JSON.stringify({
          platforms: {
            css: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [{ destination: 'named.css', format: 'css/variables' }],
              transformGroup: 'css',
            },
          },
          source: [missing],
        }),
      )

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // Resolves rather than throws, because `failOnError: false` asked for
        // the report without the failure — which is the case this asserts the
        // message of.
        await callBuildStart(
          vitePlugin({
            config: barren,
            failOnError: false,
            logLevel: 'silent',
          }),
        )

        const said = errorSpy.mock.calls.map((call) => String(call[0]))
        expect(said.some((line) => line.includes(missing))).toBe(true)
        expect(said.some((line) => line.includes(barren))).toBe(true)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('does not fire for a configuration that supplies its tokens inline', async () => {
      // Style Dictionary accepts a `tokens` object with no `source` at all, so
      // "no source matched" and "no tokens" are different questions and only
      // the second may fail a build. Checking the patterns instead of the
      // resolved set would reject this configuration, which is valid and
      // builds correctly.
      const inline = path.join(tempDir, 'inline.config.json')
      fs.writeFileSync(
        inline,
        JSON.stringify({
          platforms: {
            css: {
              buildPath: tempDir.replace(/\\/g, '/') + '/',
              files: [{ destination: 'inline.css', format: 'css/variables' }],
              transformGroup: 'css',
            },
          },
          tokens: { color: { inline: { value: '#00ff00' } } },
        }),
      )

      await callBuildStart(vitePlugin({ config: inline, logLevel: 'silent' }))

      const written = fs.readFileSync(path.join(tempDir, 'inline.css'), 'utf-8')
      expect(written).toContain('--color-inline: #00ff00;')
    })
  })
})

// Nothing pinned the exports map, and two of the ways it breaks leave every
// other check green: `default` rewritten to `import` drops every CommonJS
// consumer, and a target losing its entry is invisible to a suite that
// imports from `src`. `scripts/check-package.mjs` resolves all of this for
// real, but only against a build; these run on the source tree.
describe('the exports map', () => {
  // Each subpath is spelled out rather than indexed by a computed key, so the
  // JSON's own types carry through and a renamed entry is a type error here
  // rather than an assertion against `undefined`.
  const entryPoints = [
    { conditions: packageJson.exports['.'], file: 'index', subpath: '.' },
    {
      conditions: packageJson.exports['./rolldown'],
      file: 'rolldown',
      subpath: './rolldown',
    },
    {
      conditions: packageJson.exports['./rollup'],
      file: 'rollup',
      subpath: './rollup',
    },
    {
      conditions: packageJson.exports['./vite'],
      file: 'vite',
      subpath: './vite',
    },
    {
      conditions: packageJson.exports['./webpack'],
      file: 'webpack',
      subpath: './webpack',
    },
  ]

  it('publishes an entry point per bundler, plus the main one', () => {
    // Compared as a set rather than in order: every subpath here is exact,
    // so Node matches them whatever the order, and the file leads with
    // `./vite` because that is the target the README leads with.
    expect(new Set(Object.keys(packageJson.exports))).toEqual(
      new Set([
        './package.json',
        ...entryPoints.map((entryPoint) => entryPoint.subpath),
      ]),
    )
  })

  it.each(entryPoints)(
    'serves $subpath through `default`, which is what buys CommonJS support',
    ({ conditions }) => {
      // Under `import` alone the same require() fails with
      // ERR_PACKAGE_PATH_NOT_EXPORTED and every CommonJS consumer is dropped,
      // while the package still builds and publint still reports no problem.
      // Vitest cannot require the built package, so what is pinned here is
      // the condition that decides it — and its position, since `types` has
      // to be matched before anything that could shadow it.
      expect(Object.keys(conditions)).toEqual(['types', 'default'])
    },
  )

  it.each(entryPoints)(
    'points $subpath at the `.js` extension the build emits',
    ({ conditions, file }) => {
      // tsdown emits `.mjs` unless `fixedExtension: false` holds it to `.js`,
      // and that line reads as redundant. Removing it republishes the package
      // at paths these conditions do not name.
      expect(conditions.default).toBe(`./dist/${file}.js`)
      expect(conditions.types).toBe(`./dist/${file}.d.ts`)
    },
  )

  it('agrees with the top-level fields that predate it', () => {
    expect(packageJson.main).toBe(packageJson.exports['.'].default)
    expect(packageJson.module).toBe(packageJson.exports['.'].default)
    expect(packageJson.types).toBe(packageJson.exports['.'].types)
  })

  it('ships the directory every entry point resolves into', () => {
    expect(packageJson.files).toContain('dist')
  })
})

// The plugin's own rebuild line is what a consumer sees, so it is what these
// count: before the scheduler, one logical change printed it once per file.
const countRebuildLines = (spy: MockInstance<typeof console.log>) =>
  spy.mock.calls.filter((call) =>
    String(call[0]).includes('Rebuilt design tokens'),
  ).length

const posix = (value: string) => value.replace(/\\/g, '/')

// Colour is presentation, and asserting on it would make a palette change look
// like a regression in the arithmetic.
// oxlint-disable-next-line no-control-regex
const ANSI = /\[\d+m/g
const stripAnsi = (value: string) => value.replace(ANSI, '')

// `<path><padding><size> kB │ gzip: <size> kB`, with the byte counts left
// loose: sizes move when Style Dictionary changes a header comment, and a test
// that breaks on that pins the wrong thing.
const SIZE_LINE = /^\S+ {2,}\d+\.\d{2} kB │ gzip: \d+\.\d{2} kB$/

// A sibling `.tmp` left on disk is the failure the atomic-writer cases look
// for: the temporary file only outlives its rename when something threw
// between the two, and one left behind is a file the next glob can pick up.
const temporaries = (directory: string) =>
  fs
    .readdirSync(path.join(directory, 'out'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)

const settle = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Poll rather than wait a fixed window. A watcher rebuild is not instant and
// not uniform, so a fixed wait either makes the suite slow or makes it flaky
// on a loaded machine; this returns as soon as the thing happened and gives up
// only when it has genuinely not.
const waitUntil = async (satisfied: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await settle(50)
}

// Every other test in this file drives the Vite target through a hand-built
// plugin context. This one runs a real second host, because the defect it pins
// is invisible without one: it lives in how a bundler re-enters `buildStart`
// on every watch rebuild, which no stub can reproduce.
describe('under a real rollup watcher', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-rollup-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('rebuilds once for one token edit, then stops', async () => {
    // The generated file is imported by the entry, so it is in rollup's module
    // graph and every regenerate is itself a change rollup reacts to. That is
    // the cycle: write the output, the host rebuilds, the plugin compiles
    // again, the output is written again.
    const tokensDirectory = path.join(tempDir, 'tokens')
    const generatedDirectory = path.join(tempDir, 'generated')
    fs.mkdirSync(tokensDirectory, { recursive: true })
    fs.mkdirSync(generatedDirectory, { recursive: true })

    const tokenSource = path.join(tokensDirectory, 'color.json')
    const configFile = path.join(tempDir, 'sd.config.json')
    const entry = path.join(tempDir, 'entry.js')
    const outputDirectory = path.join(tempDir, 'dist')

    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#000000' } } }),
    )
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          js: {
            buildPath: generatedDirectory.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'tokens.js',
                format: 'javascript/es6',
              },
            ],
            transformGroup: 'js',
          },
        },
        // A literal path rather than a glob, so what a watcher does with an
        // unexpanded pattern is not a confound here.
        source: [tokenSource.replace(/\\/g, '/')],
      }),
    )
    // The entry uses a token export rather than importing for side effects,
    // so rollup cannot tree-shake the generated module out of the bundle and
    // the assertion below is about what a consumer would actually receive.
    fs.writeFileSync(
      entry,
      [
        "import { ColorBrand } from './generated/tokens.js'",
        'export const brand = ColorBrand',
        '',
      ].join('\n'),
    )

    let bundles = 0
    const errors: string[] = []

    const watcher = rollup.watch({
      input: entry,
      output: { dir: outputDirectory, format: 'es' },
      plugins: [rollupPlugin({ config: configFile, silent: true })],
      watch: { buildDelay: 50 },
    })

    watcher.on('event', (event) => {
      if (event.code === 'ERROR') errors.push(event.error.message)
      if (event.code === 'BUNDLE_END') {
        bundles++
        void event.result.close()
      }
    })

    // A second listener, so the wait below is driven by the watcher rather
    // than by a fixed delay: a slow machine lengthens this test instead of
    // failing it.
    const firstBundle = new Promise<void>((resolve) => {
      watcher.on('event', (event) => {
        if (event.code === 'BUNDLE_END') resolve()
      })
    })

    try {
      await Promise.race([firstBundle, settle(15000)])
      expect(errors).toEqual([])
      expect(bundles).toBeGreaterThan(0)

      // chokidar reports nothing for a moment after the watcher is built, and
      // an edit landing inside that window is missed by the watcher rather
      // than by the plugin.
      await settle(500)

      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )

      // Wait for the edit to have been noticed at all before measuring
      // whether the rebuilds stop, so a slow watcher cannot be mistaken for a
      // converged one.
      const generated = () =>
        fs.readFileSync(path.join(generatedDirectory, 'tokens.js'), 'utf-8')
      await waitUntil(() => generated().includes('#ff0000'), 15000)

      // Then let everything in flight land, and only then start counting.
      await settle(3000)
      const afterEdit = bundles
      await settle(3000)

      // Converged is the property that matters, and it is what the loop
      // violated: before the fix this ran at about ten bundles a second and
      // the count was still climbing after every idle window.
      expect(bundles).toBe(afterEdit)

      // Bounded, too, rather than merely stopping eventually. A settled run
      // costs the initial bundle, the rebuild the token edit earns, and one
      // more each time the plugin writes the generated file while rollup is
      // already watching it — that write is a real module-graph change rollup
      // has to see, and it renders identical bytes the next time round and
      // stops there. The bound is generous rather than exact because the
      // watcher may batch those or split them; what it rules out is the
      // defect, which was about ten a second and still climbing.
      expect(afterEdit).toBeLessThanOrEqual(5)

      // The edit reached the consumer's bundle too, so the convergence is
      // not the plugin having stopped working.
      expect(
        fs.readFileSync(path.join(outputDirectory, 'entry.js'), 'utf-8'),
      ).toContain('#ff0000')
    } finally {
      await watcher.close()
    }
  }, 30000)

  it('notices an edit and a new file under a glob source', async () => {
    // Before the expansion this registered the pattern itself, which rollup's
    // FileWatcher treats as a filename that does not exist — so an edit under
    // a glob source produced no rebuild at all.
    const tokensDirectory = path.join(tempDir, 'tokens')
    const generatedDirectory = path.join(tempDir, 'generated')
    fs.mkdirSync(path.join(tokensDirectory, 'nested'), { recursive: true })
    fs.mkdirSync(generatedDirectory, { recursive: true })

    const tokenSource = path.join(tokensDirectory, 'nested', 'color.json')
    const configFile = path.join(tempDir, 'glob.sd.config.json')
    const entry = path.join(tempDir, 'glob-entry.js')
    const outputDirectory = path.join(tempDir, 'glob-dist')

    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { brand: { value: '#000000' } } }),
    )
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          js: {
            buildPath: generatedDirectory.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'glob-tokens.js',
                format: 'javascript/es6',
              },
            ],
            transformGroup: 'js',
          },
        },
        source: [tokensDirectory.replace(/\\/g, '/') + '/**/*.json'],
      }),
    )
    fs.writeFileSync(
      entry,
      [
        "import { ColorBrand } from './generated/glob-tokens.js'",
        'export const brand = ColorBrand',
        '',
      ].join('\n'),
    )

    let bundles = 0
    const errors: string[] = []
    const watcher = rollup.watch({
      input: entry,
      output: { dir: outputDirectory, format: 'es' },
      plugins: [rollupPlugin({ config: configFile, silent: true })],
      watch: { buildDelay: 50 },
    })

    watcher.on('event', (event) => {
      if (event.code === 'ERROR') errors.push(event.error.message)
      if (event.code === 'BUNDLE_END') {
        bundles++
        void event.result.close()
      }
    })

    const firstBundle = new Promise<void>((resolve) => {
      watcher.on('event', (event) => {
        if (event.code === 'BUNDLE_END') resolve()
      })
    })

    try {
      await Promise.race([firstBundle, settle(15000)])
      expect(errors).toEqual([])
      expect(bundles).toBe(1)

      // chokidar needs a moment after the first build before it reports
      // anything, and the fixture's directories were created seconds ago. An
      // edit landing inside that window is missed by the watcher rather than
      // by the plugin, which would fail this test for the wrong reason.
      await settle(500)

      // Waiting on the compiled output rather than on a bundle count. The
      // count is not specific enough: the plugin's own write of the generated
      // file is itself a change rollup rebuilds for, so a bundle from the
      // previous step can land after the next edit and satisfy a
      // greater-than check that nothing to do with that edit earned.
      const generated = () =>
        fs.readFileSync(
          path.join(generatedDirectory, 'glob-tokens.js'),
          'utf-8',
        )

      // An edit to a file the glob already matched.
      fs.writeFileSync(
        tokenSource,
        JSON.stringify({ color: { brand: { value: '#ff0000' } } }),
      )
      await waitUntil(() => generated().includes('#ff0000'), 15000)
      expect(generated()).toContain('#ff0000')

      // And a file created after the watcher was built, which is what
      // registering the glob's static parent directory is for.
      fs.writeFileSync(
        path.join(tokensDirectory, 'nested', 'extra.json'),
        JSON.stringify({ color: { extra: { value: '#00ff00' } } }),
      )
      await waitUntil(() => generated().includes('#00ff00'), 15000)
      expect(generated()).toContain('#00ff00')

      // Both values reach the consumer's bundle, not just the file on disk.
      const bundled = () =>
        fs.readFileSync(path.join(outputDirectory, 'glob-entry.js'), 'utf-8')
      await waitUntil(() => bundled().includes('#ff0000'), 15000)
      expect(bundled()).toContain('#ff0000')
    } finally {
      await watcher.close()
    }
  }, 40000)
})

// Editing a `.js`, `.mjs` or `.ts` config while a watcher is live used to
// change nothing about what got built, and the plugin logged a successful
// rebuild anyway. Style Dictionary imports a config path with no cache-busting
// query, and Node's ESM cache is permanent, so in a long-lived process the
// module was evaluated once and never read again — while the watch list, which
// did bust the cache, followed the edit. The two halves disagreed about what
// the config said.
describe('when the config file itself changes', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-config-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // A directory of its own per case, because the module cache is keyed on the
  // file path: two cases sharing one config filename would share its module
  // record, and the second would read whatever the first left behind.
  const fixtureDirectory = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })

    fs.writeFileSync(
      path.join(directory, 'tokens', 'color.json'),
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    return directory
  }

  // The js platform on its own, then the same config renamed and with a css
  // platform beside it — an edit that is invisible in the output unless the
  // build read the file again.
  const esmConfig = (directory: string, edited: boolean) => {
    const platforms = edited
      ? `js: { transformGroup: 'js', buildPath: '${posix(directory)}/', files: [{ destination: 'renamed.js', format: 'javascript/es6' }] },
      css: { transformGroup: 'css', buildPath: '${posix(directory)}/', files: [{ destination: 'vars.css', format: 'css/variables' }] },`
      : `js: { transformGroup: 'js', buildPath: '${posix(directory)}/', files: [{ destination: 'tokens.js', format: 'javascript/es6' }] },`

    return `export default {
      source: ['${posix(path.join(directory, 'tokens'))}/*.json'],
      platforms: { ${platforms} },
    }
`
  }

  it('builds what an edited .mjs config says, not what it said at startup', async () => {
    const directory = fixtureDirectory('esm')
    const configFile = path.join(directory, 'sd.config.mjs')
    fs.writeFileSync(configFile, esmConfig(directory, false))

    const plugin = vitePlugin({ config: configFile, silent: true })
    await callBuildStart(plugin)

    expect(fs.existsSync(path.join(directory, 'tokens.js'))).toBe(true)

    // Far enough apart that the edit lands on a different mtime, which is what
    // the import query is keyed on.
    await settle(20)
    fs.writeFileSync(configFile, esmConfig(directory, true))

    await callWatchChange(plugin, posix(configFile))

    // Unpatched, both of these are missing and the rebuild is logged as a
    // success: the module cache served the platform map from start-up.
    expect(fs.existsSync(path.join(directory, 'renamed.js'))).toBe(true)
    expect(fs.existsSync(path.join(directory, 'vars.css'))).toBe(true)
    expect(
      fs.readFileSync(path.join(directory, 'vars.css'), 'utf-8'),
    ).toContain('#0070f3')
  }, 30000)

  it('evaluates an unchanged ESM config once however many events arrive', async () => {
    const directory = fixtureDirectory('once')
    const configFile = path.join(directory, 'sd.config.mjs')
    const evaluations = path.join(directory, 'evaluations.log')

    // The side effect stands in for the `registerFormat` calls a real config
    // makes at import time, and it is recorded outside the module because
    // every re-evaluation is a fresh instance with its own module scope.
    fs.writeFileSync(
      configFile,
      `import fs from 'node:fs'
fs.appendFileSync('${posix(evaluations)}', 'x')
${esmConfig(directory, false)}`,
    )

    const plugin = vitePlugin({ config: configFile, silent: true })
    await callBuildStart(plugin)

    const tokenSource = posix(path.join(directory, 'tokens', 'color.json'))
    for (let index = 0; index < 5; index += 1) {
      // Spaced past a millisecond, so a `Date.now()` key would be a distinct
      // key rather than a collision.
      await settle(5)
      await callWatchChange(plugin, tokenSource)
    }

    // Unpatched this is two, and the second one is the point: Style Dictionary
    // imported the config file itself, beside the copy this plugin had already
    // imported to build the watch list. One file, two module records, two runs
    // of whatever the config does at import time.
    //
    // Two rather than seven because of where this runs. Under plain Node the
    // same fixture reaches seven, since the old `?t=${Date.now()}` key made
    // every watcher event a new module record in a map nothing prunes. Vitest
    // serves this plugin's own imports through Vite's module runner, which
    // caches by file and invalidates on change, so the growth is invisible
    // here — which is why the count is pinned at one rather than at a delta.
    expect(fs.readFileSync(evaluations, 'utf-8')).toBe('x')
  }, 30000)

  it('still picks up an edited .json config', async () => {
    const directory = fixtureDirectory('json')
    const configFile = path.join(directory, 'sd.config.json')

    const jsonConfig = (destination: string) =>
      JSON.stringify({
        platforms: {
          js: {
            buildPath: posix(directory) + '/',
            files: [{ destination, format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [posix(path.join(directory, 'tokens')) + '/*.json'],
      })

    fs.writeFileSync(configFile, jsonConfig('tokens.js'))

    const plugin = vitePlugin({ config: configFile, silent: true })
    await callBuildStart(plugin)

    expect(fs.existsSync(path.join(directory, 'tokens.js'))).toBe(true)

    await settle(20)
    fs.writeFileSync(configFile, jsonConfig('renamed.js'))

    await callWatchChange(plugin, posix(configFile))

    // The control: a `.json` path is still handed to Style Dictionary as a
    // path, so this half has to keep working unchanged.
    expect(fs.existsSync(path.join(directory, 'renamed.js'))).toBe(true)
  }, 30000)
})

// `watchChange` used to resolve every configuration before it asked whether
// the changed file mattered, and under Vite the scope this hook sees is the
// whole project root rather than the module graph. So every unrelated file a
// dev server noticed ran the consumer's own `config` function — the place the
// README tells them to register custom formats — and threw the answer away.
describe('when a watched change is not a token source', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-filter-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('does not resolve the config for a file that matches nothing', async () => {
    const directory = path.join(tempDir, 'filter')
    fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })

    const tokenSource = path.join(directory, 'tokens', 'color.json')
    fs.writeFileSync(
      tokenSource,
      JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
    )

    // A file the plugin has no interest in, standing in for everything a dev
    // server's watcher reports from the project root.
    const unrelated = path.join(directory, 'notes.md')
    fs.writeFileSync(unrelated, 'nothing to do with tokens\n')

    let calls = 0
    const plugin = vitePlugin({
      config: () => {
        calls += 1

        return {
          platforms: {
            js: {
              buildPath: posix(directory) + '/',
              files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
              transformGroup: 'js',
            },
          },
          source: [posix(path.join(directory, 'tokens')) + '/*.json'],
        }
      },
      silent: true,
    })

    await callBuildStart(plugin)
    const afterBuild = calls
    expect(afterBuild).toBeGreaterThan(0)

    // A change the plugin does care about still costs a resolution, because a
    // rebuild needs one — that is what makes the assertion below about the
    // filter rather than about the function never running.
    await callWatchChange(plugin, posix(tokenSource))
    expect(calls).toBeGreaterThan(afterBuild)

    const afterMatch = calls
    for (let index = 0; index < 5; index += 1) {
      await callWatchChange(plugin, posix(unrelated))
    }

    // Unpatched this is five: one full resolution per unrelated file, each of
    // them running the consumer's function before discarding what it returned.
    expect(calls - afterMatch).toBe(0)
  }, 30000)
})

// The watch list used to be derived by a different parser from the one the
// build reads the file with. `.json5` and `.jsonc` went down the import branch
// and failed there while the build succeeded, and a `.json` config carrying a
// comment failed strict `JSON.parse` for the same reason — so the config built
// correctly and then lost every `source` pattern from its watch set, with the
// parse error logged and the build reported as a success right after it.
describe('every supported config file format', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-formats-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // Each case writes the same configuration in its own syntax. The JSON family
  // carries a comment and a trailing comma on purpose: that is the half of
  // JSON5 a strict parser rejects, and `.json` is the format the README leads
  // with.
  const jsonFamily = (directory: string) => `{
  // a comment, which only a JSON5 parser accepts
  platforms: {
    js: {
      transformGroup: 'js',
      buildPath: '${posix(directory)}/',
      files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
    },
  },
  source: ['${posix(path.join(directory, 'tokens'))}/*.json'],
}
`

  const esmFamily = (directory: string) => `export default {
  platforms: {
    js: {
      transformGroup: 'js',
      buildPath: '${posix(directory)}/',
      files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
    },
  },
  source: ['${posix(path.join(directory, 'tokens'))}/*.json'],
}
`

  // `satisfies` is the point: it is type syntax, so the file only imports at
  // all where Node strips types.
  const typescript = (directory: string) =>
    esmFamily(directory).replace(/\n$/, ' satisfies Record<string, unknown>\n')

  it.each([
    { extension: 'json', write: jsonFamily },
    { extension: 'json5', write: jsonFamily },
    { extension: 'jsonc', write: jsonFamily },
    { extension: 'js', write: esmFamily },
    { extension: 'mjs', write: esmFamily },
    { extension: 'ts', write: typescript },
  ])(
    'builds and watches the sources of a .$extension config',
    async ({ extension, write }) => {
      const directory = path.join(tempDir, extension)
      fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })
      fs.writeFileSync(
        path.join(directory, 'tokens', 'color.json'),
        JSON.stringify({ color: { primary: { value: '#0070f3' } } }),
      )

      const configFile = path.join(directory, `sd.config.${extension}`)
      fs.writeFileSync(configFile, write(directory))

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const plugin = vitePlugin({ config: configFile, silent: true })
        const watched = await callBuildStart(plugin)

        // The build half, which was never the broken one for the JSON family.
        expect(
          fs.readFileSync(path.join(directory, 'tokens.js'), 'utf-8'),
        ).toContain('#0070f3')

        // The half that was lost: the config file alone used to be the whole
        // watch list, so editing a token rebuilt nothing.
        expect(watched).toContain(posix(configFile))
        expect(watched).toContain(
          posix(path.join(directory, 'tokens', 'color.json')),
        )

        // And nothing was reported while that happened, which is what made it
        // silent — the parse failure was logged and the build then said it had
        // succeeded.
        expect(errorSpy.mock.calls.map((call) => String(call[0]))).toEqual([])
      } finally {
        errorSpy.mockRestore()
      }
    },
    30000,
  )
})

// Nothing asserted the watch list itself. `getWatchTargets` was only ever
// reached with a single JSON config carrying `source` and no `include`, so
// default discovery, the `include` key and the `watch` option all worked and
// nothing in the suite would have noticed if any of the three had stopped.
describe('the watch list a build registers', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-watch-list-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // Literal paths rather than globs throughout, so what is registered is what
  // the configuration named and expansion is the identity. The glob path has
  // its own coverage under the rollup watcher.
  const fixture = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(path.join(directory, 'tok'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'base'), { recursive: true })

    const source = path.join(directory, 'tok', 'app.json')
    const include = path.join(directory, 'base', 'base.json')
    // Self-contained on purpose: most cases below load the source without the
    // include, and a token referencing one that is not loaded fails the build
    // for a reason that has nothing to do with the watch list.
    fs.writeFileSync(
      source,
      JSON.stringify({ color: { app: { value: '#0070f3' } } }),
    )
    fs.writeFileSync(
      include,
      JSON.stringify({ color: { base: { value: '#101828' } } }),
    )

    const platforms = {
      js: {
        buildPath: posix(directory) + '/',
        files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
        transformGroup: 'js',
      },
    }

    return { directory, include, platforms, source }
  }

  it('registers the config file, every source and every include', async () => {
    const { directory, include, platforms, source } = fixture('source-include')
    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        include: [posix(include)],
        platforms,
        source: [posix(source)],
      }),
    )

    const watched = await callBuildStart(
      vitePlugin({ config: configFile, silent: true }),
    )

    // Exact rather than `toContain`: a watch list that silently gains an entry
    // is how the plugin came to watch its own output.
    expect(new Set(watched)).toEqual(
      new Set([posix(configFile), posix(include), posix(source)]),
    )
  }, 30000)

  it('registers the same list for a config loaded by dynamic import', async () => {
    const { directory, include, platforms, source } = fixture('esm-config')
    const configFile = path.join(directory, 'sd.config.mjs')
    fs.writeFileSync(
      configFile,
      `export default ${JSON.stringify({
        include: [posix(include)],
        platforms,
        source: [posix(source)],
      })}\n`,
    )

    const watched = await callBuildStart(
      vitePlugin({ config: configFile, silent: true }),
    )

    expect(new Set(watched)).toEqual(
      new Set([posix(configFile), posix(include), posix(source)]),
    )
  }, 30000)

  it('registers both configs and both their sources when given two', async () => {
    const first = fixture('multi-first')
    const second = fixture('multi-second')

    const firstConfig = path.join(first.directory, 'sd.config.json')
    const secondConfig = path.join(second.directory, 'sd.config.json')
    fs.writeFileSync(
      firstConfig,
      JSON.stringify({
        platforms: first.platforms,
        source: [posix(first.source)],
      }),
    )
    fs.writeFileSync(
      secondConfig,
      JSON.stringify({
        platforms: second.platforms,
        source: [posix(second.source)],
      }),
    )

    const watched = await callBuildStart(
      vitePlugin({ config: [firstConfig, secondConfig], silent: true }),
    )

    expect(new Set(watched)).toEqual(
      new Set([
        posix(first.source),
        posix(firstConfig),
        posix(second.source),
        posix(secondConfig),
      ]),
    )
  }, 30000)

  it.each([
    { form: 'a string', watch: (file: string) => file },
    { form: 'an array', watch: (file: string) => [file] },
  ])(
    'appends the watch option given as $form',
    async ({ watch }) => {
      const { directory, platforms, source } = fixture(
        `watch-option-${String(watch('x'))}`,
      )
      const configFile = path.join(directory, 'sd.config.json')
      fs.writeFileSync(
        configFile,
        JSON.stringify({ platforms, source: [posix(source)] }),
      )

      const extra = path.join(directory, 'notes.txt')
      fs.writeFileSync(extra, 'watched because the consumer asked\n')

      const watched = await callBuildStart(
        vitePlugin({ config: configFile, silent: true, watch: watch(extra) }),
      )

      expect(new Set(watched)).toEqual(
        new Set([posix(configFile), posix(extra), posix(source)]),
      )
    },
    30000,
  )

  // `source` and `include` are documented as arrays and Style Dictionary
  // rejects anything else, but the watch list is built before the build runs
  // and handles the bare-string form rather than dropping it silently. That
  // is the difference between a configuration that fails loudly and one that
  // fails loudly *and* watches nothing.
  it('registers a source and an include given as bare strings', async () => {
    const { directory, include, platforms, source } = fixture('bare-strings')
    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        include: posix(include),
        platforms,
        source: posix(source),
      }),
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const watched = await callBuildStart(
        vitePlugin({ config: configFile, failOnError: 'serve', silent: true }),
      )

      expect(new Set(watched)).toEqual(
        new Set([posix(configFile), posix(include), posix(source)]),
      )
    } finally {
      errorSpy.mockRestore()
    }
  }, 30000)

  // Four filenames, not the two `src/types.ts` and the README claim. The
  // documents are wrong and correcting them is the documentation work's; what
  // this pins is what the code does.
  it.each(['sd.config.json', 'config.json', 'sd.config.js', 'sd.config.mjs'])(
    'discovers %s with no config option at all',
    async (filename) => {
      const { directory, platforms, source } = fixture(
        `discover-${filename.replace(/\./g, '-')}`,
      )
      const body = { platforms, source: [posix(source)] }
      const configFile = path.join(directory, filename)
      fs.writeFileSync(
        configFile,
        filename.endsWith('.json')
          ? JSON.stringify(body)
          : `export default ${JSON.stringify(body)}\n`,
      )

      // `root` is what default discovery resolves against, and passing it is
      // what keeps this from depending on the working directory.
      const watched = await callBuildStart(
        vitePlugin({ root: directory, silent: true }),
      )

      expect(new Set(watched)).toEqual(
        new Set([posix(configFile), posix(source)]),
      )
    },
    30000,
  )
})

// A configuration that cannot be used has to come out of the plugin as a
// logged message rather than as silence or as a dead host. Every case here
// runs with `failOnError: 'serve'`, so the build completes and the assertion
// is about what was said rather than about what was thrown — the rejection
// path has its own cases above.
describe('when a configuration cannot be used', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-config-errors-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  const prepare = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(path.join(directory, 'tok'), { recursive: true })

    const source = path.join(directory, 'tok', 'app.json')
    fs.writeFileSync(
      source,
      JSON.stringify({ color: { app: { value: '#0070f3' } } }),
    )

    return { directory, source }
  }

  const buildAndCollect = async (
    options: NonNullable<Parameters<typeof vitePlugin>[0]>,
  ) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Settling at all is half of every case here: a configuration that
      // rejects a promise nobody holds used to leave `buildStart` unfinished.
      // `logLevel` ahead of the spread so a case can still override it. See
      // the note on the other broken-config block above for why `'warn'`.
      await callBuildStart(
        vitePlugin({ failOnError: 'serve', logLevel: 'warn', ...options }),
      )

      return errorSpy.mock.calls.map((call) => String(call[0]))
    } finally {
      errorSpy.mockRestore()
    }
  }

  it('reports a config path that does not exist', async () => {
    const { directory } = prepare('missing')

    const messages = await buildAndCollect({
      config: path.join(directory, 'nope.json'),
    })

    expect(
      messages.some((m) => m.includes('Failed to parse config file')),
    ).toBe(true)
  }, 30000)

  it('reports a config whose JSON is half-written', async () => {
    const { directory } = prepare('malformed')
    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(configFile, '{ "platforms": {')

    const messages = await buildAndCollect({ config: configFile })

    expect(
      messages.some((m) => m.includes('Failed to parse config file')),
    ).toBe(true)
  }, 30000)

  it('reports a config module whose default export is not an object', async () => {
    const { directory } = prepare('not-an-object')
    const configFile = path.join(directory, 'sd.config.mjs')
    fs.writeFileSync(configFile, "export default 'not a configuration'\n")

    const messages = await buildAndCollect({ config: configFile })

    expect(
      messages.some((m) =>
        m.includes('did not resolve to a configuration object'),
      ),
    ).toBe(true)
  }, 30000)

  it('reports a format name Style Dictionary does not know', async () => {
    const { directory, source } = prepare('unknown-format')
    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          js: {
            buildPath: posix(directory) + '/',
            files: [{ destination: 'tokens.js', format: 'nope/not-a-format' }],
            transformGroup: 'js',
          },
        },
        source: [posix(source)],
      }),
    )

    const messages = await buildAndCollect({ config: configFile })

    expect(messages.some((m) => m.includes('Compilation failed'))).toBe(true)
  }, 30000)

  it('reports having no configuration to compile at all', async () => {
    const { directory } = prepare('no-config')

    // An empty root, so default discovery finds none of its four filenames.
    const messages = await buildAndCollect({ root: directory })

    expect(
      messages.some((m) =>
        m.includes('No configuration specified and no default config file'),
      ),
    ).toBe(true)
  }, 30000)
})

// Every plugin in this suite used to pass `silent: true`, so the size and gzip
// reporter — sixty lines of arithmetic and column alignment, and the only
// thing a consumer sees on an ordinary build — never executed once.
describe('the size reporter', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-reporter-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  // Two platforms writing to paths of very different lengths, which is what
  // makes the alignment column observable at all.
  const writeFixture = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })

    fs.writeFileSync(
      path.join(directory, 'tokens', 'color.json'),
      JSON.stringify({ color: { brand: { value: '#0070f3' } } }),
    )

    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: posix(path.join(directory, 'out')) + '/',
            files: [{ destination: 'vars.css', format: 'css/variables' }],
            transformGroup: 'css',
          },
          js: {
            buildPath:
              posix(path.join(directory, 'out', 'deeply', 'nested')) + '/',
            files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
            transformGroup: 'js',
          },
        },
        source: [posix(path.join(directory, 'tokens')) + '/*.json'],
      }),
    )

    return { configFile, directory }
  }

  it('prints one aligned line per generated file, with sizes and gzip', async () => {
    const { configFile, directory } = writeFixture('reporting')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // `root` is what the displayed paths are relative to, so passing it is
      // what makes the expected strings independent of the working directory.
      await callBuildStart(
        vitePlugin({ config: configFile, root: directory, silent: false }),
      )

      const lines = logSpy.mock.calls.map((call) => stripAnsi(String(call[0])))
      const reported = lines.filter((line) => line.includes('gzip:'))

      expect(reported).toHaveLength(2)

      // The shape, rather than the exact byte counts: sizes move when Style
      // Dictionary changes a header comment, and a test that breaks on that
      // is pinning the wrong thing.
      for (const line of reported) {
        expect(line).toMatch(SIZE_LINE)
      }

      expect(reported.some((line) => line.startsWith('out/vars.css'))).toBe(
        true,
      )
      expect(
        reported.some((line) => line.startsWith('out/deeply/nested/tokens.js')),
      ).toBe(true)

      // The alignment: both size columns begin at the same offset, which is
      // the whole purpose of the padding arithmetic.
      const columns = reported.map((line) => line.indexOf('kB'))
      expect(new Set(columns).size).toBe(1)
    } finally {
      logSpy.mockRestore()
    }
  }, 30000)

  it('prints nothing at all when silent', async () => {
    const { configFile, directory } = writeFixture('silent')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await callBuildStart(
        vitePlugin({ config: configFile, root: directory, silent: true }),
      )

      expect(logSpy.mock.calls).toEqual([])
    } finally {
      logSpy.mockRestore()
    }
  }, 30000)

  // A fault in the table is a reporting failure, not a compile failure. The
  // reporter used to sit inside the same `try` as the compile, so a throw
  // from it was logged as `Compilation failed` and — with `failOnError`
  // defaulting to `'build'` — rethrown into the host, stopping a bundler over
  // a build whose every token file was already written and correct.
  it('survives a fault in its own table without failing the build', async () => {
    const { configFile, directory } = writeFixture('reporter-throws')

    // `path.relative` is the reporter's first call on each destination, and
    // it is the only one in that block the per-file `catch` does not cover.
    // Nothing else in the compile path uses it — neither this plugin nor
    // Style Dictionary — and the throw is narrowed to `relative(root, …)`,
    // which is the call shape only the reporter makes. So a pass here cannot
    // come from having broken something earlier and caught it later.
    const relative = path.relative
    let faulted = 0
    const relativeSpy = vi
      .spyOn(path, 'relative')
      .mockImplementation((from, to) => {
        if (from === directory) {
          faulted += 1
          throw new Error('relative is unavailable')
        }

        return relative(from, to)
      })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      // On the unfixed plugin this rejects with the reporter's own error, and
      // that rejection is the whole defect: the hook fails a build that
      // succeeded.
      await callBuildStart(
        vitePlugin({ config: configFile, root: directory, silent: false }),
      )

      const errors = errorSpy.mock.calls.map((call) => String(call[0]))
      const printed = logSpy.mock.calls.map((call) =>
        stripAnsi(String(call[0])),
      )

      // The fault was actually provoked. Without this the case would pass on
      // a build that never reached the reporter at all.
      expect(faulted).toBeGreaterThan(0)

      // Every destination written, and written correctly: Style Dictionary
      // had finished long before the reporter ran.
      expect(
        fs.readFileSync(path.join(directory, 'out', 'vars.css'), 'utf8'),
      ).toContain('--color-brand: #0070f3;')
      expect(
        fs.readFileSync(
          path.join(directory, 'out', 'deeply', 'nested', 'tokens.js'),
          'utf8',
        ),
      ).toContain('#0070f3')

      // Said, because a table that cannot be printed is worth a line — but
      // said as what it is.
      expect(errors.some((line) => line.includes('Compilation failed'))).toBe(
        false,
      )
      expect(
        errors.some((line) =>
          line.includes('Failed to report generated file sizes'),
        ),
      ).toBe(true)

      // No table, since printing it is what faulted; and the compile still
      // reported as the success it was.
      expect(printed.some((line) => SIZE_LINE.test(line))).toBe(false)
      expect(
        printed.some((line) => line.includes('Compiled successfully!')),
      ).toBe(true)
    } finally {
      relativeSpy.mockRestore()
      errorSpy.mockRestore()
      logSpy.mockRestore()
    }
  }, 30000)
})

// `writeFileSyncAtomic` never runs under Style Dictionary's own writes — it
// has no synchronous write path — but a custom action receives the same volume
// and can. The concurrent-reader test pins the async half; this pins that the
// sync half is installed and behaves the same way.
describe('the atomic writer', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'unplugin-style-dictionary-atomic-'),
  )

  afterEach(() => {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  const writeFixture = (name: string) => {
    const directory = path.join(tempDir, name)
    fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'tokens', 'color.json'),
      JSON.stringify({ color: { brand: { value: '#0070f3' } } }),
    )

    return directory
  }

  it('reaches Style Dictionary custom actions as the sync writer', async () => {
    const directory = writeFixture('sync-writer')

    // Registered by name rather than inlined: an inline action object throws
    // `Cannot read properties of undefined (reading 'undo')` on
    // style-dictionary 5.5.3.
    let observedName: string | undefined
    let wroteThrough: string | undefined
    StyleDictionary.registerAction({
      // Four parameters, and the volume is the last of them —
      // `performActions` calls `action.do(dictionary, platform, options, vol)`.
      do: (_dictionary, platform, _options, vol) => {
        observedName = vol.writeFileSync.name

        wroteThrough = path.join(String(platform.buildPath), 'from-action.txt')
        vol.writeFileSync(wroteThrough, 'written by a custom action\n')
      },
      name: 'test/write-through-volume',
      undo: () => {},
    })

    const configFile = path.join(directory, 'sd.config.json')
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          css: {
            actions: ['test/write-through-volume'],
            buildPath: posix(path.join(directory, 'out')) + '/',
            files: [{ destination: 'vars.css', format: 'css/variables' }],
            transformGroup: 'css',
          },
        },
        source: [posix(path.join(directory, 'tokens')) + '/*.json'],
      }),
    )

    await callBuildStart(vitePlugin({ config: configFile, silent: true }))

    // The claim the comment in `src/index.ts` makes, checked rather than
    // trusted: an action's own writes go through the atomic path too.
    expect(observedName).toBe('writeFileSyncAtomic')
    expect(fs.readFileSync(String(wroteThrough), 'utf-8')).toContain(
      'written by a custom action',
    )
    expect(temporaries(directory)).toEqual([])
  }, 30000)

  it.each([
    { half: 'async', method: 'rename' as const },
    { half: 'sync', method: 'renameSync' as const },
  ])(
    'leaves no temporary behind when the $half rename fails',
    async ({ method }) => {
      const directory = writeFixture(`rename-fails-${method}`)
      fs.mkdirSync(path.join(directory, 'out'), { recursive: true })

      const actions =
        method === 'renameSync' ? ['test/write-through-volume'] : undefined

      const configFile = path.join(directory, 'sd.config.json')
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          platforms: {
            css: {
              ...(actions ? { actions } : {}),
              buildPath: posix(path.join(directory, 'out')) + '/',
              files: [{ destination: 'vars.css', format: 'css/variables' }],
              transformGroup: 'css',
            },
          },
          source: [posix(path.join(directory, 'tokens')) + '/*.json'],
        }),
      )

      // The rename is the only step between a written temporary file and a
      // replaced destination, so failing it is what strands one.
      const failure = new Error(`forced ${method} failure`)
      const renameSpy =
        method === 'rename'
          ? vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure)
          : vi.spyOn(fs, 'renameSync').mockImplementation(() => {
              throw failure
            })

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(
          callBuildStart(vitePlugin({ config: configFile, silent: true })),
        ).rejects.toThrow(/forced .* failure/)

        expect(temporaries(directory)).toEqual([])
      } finally {
        errorSpy.mockRestore()
        renameSpy.mockRestore()
      }
    },
    30000,
  )
})

// A consumer importing the entry point for their bundler should be able to
// name the options type from that same specifier. The type is erased at
// runtime, so nothing about a build or an import can observe it — what the
// re-export leaves behind is a line in the source and a clause in the emitted
// declaration, and both are checked: this suite reads the source, and
// `scripts/check-package.mjs` reads the built `.d.ts` after `npm run build`.
describe('the options type on every target entry', () => {
  const targets = ['rolldown', 'rollup', 'vite', 'webpack']

  it.each(targets)(
    'src/%s.ts re-exports the options type alongside the plugin',
    (target) => {
      const source = fs.readFileSync(
        new URL(`../src/${target}.ts`, import.meta.url),
        'utf-8',
      )

      // `export type *` rather than a named re-export, so a type added to
      // `src/types.ts` travels without a second edit here.
      expect(source).toContain("export type * from './types.js'")
    },
  )
})

// The README reproduces `UnpluginStyleDictionaryOptions` as a TypeScript
// fence, and nothing checked it: `npm run lint` formats Markdown but does not
// read a fence's contents, and the suite pinned `package.json`'s exports map
// without ever opening README.md. The copy drifted for months — by the time
// this was written it was missing `cache` and `report` entirely, two options
// that exist and were therefore documented nowhere in the reference a reader
// is pointed at.
//
// Compared whitespace-normalised rather than byte for byte, because oxfmt owns
// the wrapping in both files and wraps a Markdown fence differently from a
// TypeScript source. What has to match is the text, not the column it breaks
// at.
// Everything from the first JSDoc block to the end of the file, which is both
// exported interfaces — the options and the build context handed to the
// function form of `config`. The `import type` line above is noise in a
// README, and this is the one place that decides where the block starts — the
// README section is produced by slicing `src/types.ts` at exactly this point.
const optionsContract = () => {
  const source = fs.readFileSync(
    new URL('../src/types.ts', import.meta.url),
    'utf-8',
  )

  return source.slice(source.indexOf('/**'))
}

const readmeFence = () => {
  const readme = fs.readFileSync(
    new URL('../README.md', import.meta.url),
    'utf-8',
  )

  const heading = '## Options Reference'
  const begin = readme.indexOf(heading)
  if (begin === -1)
    throw new Error('README.md has no Options Reference heading')

  const section = readme.slice(begin, readme.indexOf('\n## ', begin + 5))
  const fence = /```typescript\n(?<body>[\s\S]*?)\n```/.exec(section)
  if (!fence?.groups?.body) {
    throw new Error('the Options Reference section carries no typescript fence')
  }

  return fence.groups.body
}

// oxfmt owns the wrapping in both files and wraps a Markdown fence differently
// from a TypeScript source, so what has to match is the text rather than the
// column it breaks at.
const normaliseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

// The README reproduces `UnpluginStyleDictionaryOptions` as a TypeScript fence,
// and nothing checked it: `npm run lint` formats Markdown but never reads a
// fence's contents, and the suite pinned `package.json`'s exports map without
// ever opening README.md. The copy drifted for months — by the time this was
// written it had lost `cache` and `report` entirely, two options that exist and
// were therefore absent from the reference a reader is pointed at.
describe('the README options reference', () => {
  it('reproduces the options interface, including its own JSDoc', () => {
    // The interface-level JSDoc is the part the hand copy dropped, and it is
    // where the per-target watch caveat lives — the most misread thing about
    // this plugin. Asserted on its own so losing it fails with its own message
    // rather than as one line inside a whole-block mismatch.
    expect(normaliseWhitespace(readmeFence())).toContain(
      normaliseWhitespace('Options for the Style Dictionary unplugin factory'),
    )

    expect(normaliseWhitespace(readmeFence())).toBe(
      normaliseWhitespace(optionsContract()),
    )
  })

  it('documents every default-discovery filename the code tries', () => {
    // Wrong since the initial commit in both copies: they named two of the
    // four. Pinned against the array rather than against a transcription, so a
    // fifth filename fails here rather than going undocumented.
    const source = fs.readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    )
    const defaults = /const defaults = \[(?<body>[\s\S]*?)\]/.exec(source)
    const filenames = [
      ...(defaults?.groups?.body ?? '').matchAll(/'([^']+)'/g),
    ].map((match) => match[1])

    expect(filenames.length).toBeGreaterThan(0)

    const contract = optionsContract()
    for (const filename of filenames) {
      expect(contract, `${filename} is undocumented`).toContain(filename)
    }
  })
})
