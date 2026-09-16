import type { Plugin } from 'vite'
import type { MockInstance } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as rollup from 'rollup'
import StyleDictionary from 'style-dictionary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import { matchesWatchedFile } from '../src/index.ts'
import rollupPlugin from '../src/rollup.ts'
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
      // Past the debounce, so the two are not merged into one rebuild, and
      // well inside the build above, so without the in-flight chain the
      // second starts beside the first.
      const first = callWatchChange(plugin, bulkToken)
      await settle(150)
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
      try {
        const plugin = vitePlugin({ config: brokenConfigFile })

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
