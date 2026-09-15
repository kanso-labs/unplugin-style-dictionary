import type { Plugin } from 'vite'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import StyleDictionary from 'style-dictionary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import { matchesWatchedFile } from '../src/index.ts'
import vitePlugin from '../src/vite.ts'

interface BuildContext {
  addWatchFile: (id: string) => void
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
const callBuildStart = async (plugin: Plugin) => {
  const context: BuildContext = { addWatchFile: () => {} }
  if (!isPluginHook<[]>(plugin.buildStart)) {
    throw new TypeError('buildStart is not a callable hook')
  }
  await plugin.buildStart.call(context)
}

const callWatchChange = async (plugin: Plugin, id: string) => {
  const context: BuildContext = { addWatchFile: () => {} }
  if (!isPluginHook<[string]>(plugin.watchChange)) {
    throw new TypeError('watchChange is not a callable hook')
  }
  await plugin.watchChange.call(context, id)
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
    const color: Record<string, { value: string }> = {}
    for (let index = 0; index < 4000; index++) {
      color[`swatch${index}`] = {
        value: `#${(index % 0xffffff).toString(16).padStart(6, '0')}`,
      }
    }

    fs.writeFileSync(concurrentTokenFile, JSON.stringify({ color }))
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

    // Build once so there is a complete file to compare every later read
    // against. The tokens never change, so every rebuild must produce this
    // exact content — anything else the reader sees is a partial write.
    await callBuildStart(plugin)
    const expected = fs.readFileSync(concurrentOutputFile, 'utf-8')

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

        if (content !== expected) {
          // Report it the way a consumer meets it — as a parse failure —
          // together with how much of the file this read actually saw.
          let reason = 'parsed, but the content differs'
          try {
            JSON.parse(content)
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err)
          }
          failures.push(
            `${reason} (read ${content.length} of ${expected.length} bytes)`,
          )
        }

        // Yield so the rebuild below can make progress between reads.
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()

    for (let index = 0; index < rebuilds; index++) {
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
