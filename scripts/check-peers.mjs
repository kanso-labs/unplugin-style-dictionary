#!/usr/bin/env node
// Drives the ends of every declared peer range against the packed tarball.
//
// `package.json` makes six compatibility claims — `vite ^6 || ^7 || ^8`,
// `style-dictionary ^5`, and `*` for rolldown, rollup, rspack and webpack —
// and until this existed nothing stood behind any of them.
// `tests/targets.test.ts` drives all five bundlers, which covers the adapters,
// but only against the single version `devDependencies` pins: it cannot see a
// range end going stale.
//
// It installs the tarball rather than the working tree on purpose. A consumer
// gets the packed file list resolved through the exports map, which is the
// thing `scripts/check-package.mjs` checks the shape of and this exercises the
// use of — a file missing from `files` fails here as a resolution error rather
// than passing because the repository happens to have it on disk.
//
// Each fixture drives its bundler through the Node API rather than a CLI. The
// CLIs bring their own resolution and their own defaults, and what is under
// test is this package's entry points.
//
// A Vite fixture runs a second phase after its build: a dev server in the same
// directory, taken through a token edit. `build()` returns before
// `configResolved` reaches its serve branch and never calls `configureServer`,
// so without it the ignore-list amendment, `server.watcher.add` and the
// `buildEnd` cleanup met no Vite but the one `devDependencies` pins.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'

const root = new URL('..', import.meta.url).pathname

// The age every npm upgrade here waits out before Renovate raises it, set by
// the `security:minimumReleaseAgeNpm` preset `.github/renovate.json` extends —
// the number lives in that preset, not in a file here. The fixtures follow the
// registry only up to the same cutoff, so a bundler release broken and then
// fixed or yanked inside the window does not turn `Build` red meanwhile; a
// release that is genuinely incompatible still does, once it is old enough.
const MINIMUM_RELEASE_AGE_DAYS = 3
const cutoff = Date.now() - MINIMUM_RELEASE_AGE_DAYS * 24 * 60 * 60 * 1000

// Every fixture writes this, and every fixture asserts on it.
//
// A JavaScript format rather than CSS: rollup and rolldown cannot resolve a
// `.css` import without a loader plugin, and what is under test is this
// package's entry points, not anyone's css handling. A JS module is the one
// shape all five bundlers take unaided.
const TOKEN = '#0070f3'
const EXPECTED = '#0070f3'

// What the dev-server phase writes over the token, and the file it writes.
// The file is the fixture's one source, so the edit is one the plugin has to
// rebuild for.
const EDITED = '#ff0000'
const EDITED_FILE = 'tokens/color.json'

// How long the dev-server phase waits for each regeneration. A rebuild here
// takes well under a second, so reaching it means nothing is coming — and the
// phase fails rather than holding `Build` to its ten-minute timeout.
const DEADLINE_MS = 20_000

// One driver per bundler, named rather than looked up by key: a computed
// lookup is untypeable here and the guard it needs is noise beside seven
// constants.
const ROLLDOWN_DRIVER = `
    import { rolldown } from 'rolldown'
    import plugin from '@kanso-labs/unplugin-style-dictionary/rolldown'
    const bundle = await rolldown({ input: 'entry.js', plugins: [plugin({ config: CONFIG })] })
    await bundle.generate({ format: 'es' })
    await bundle.close()
  `

const ROLLUP_DRIVER = `
    import { rollup } from 'rollup'
    import plugin from '@kanso-labs/unplugin-style-dictionary/rollup'
    const bundle = await rollup({ input: 'entry.js', plugins: [plugin({ config: CONFIG })] })
    await bundle.generate({ format: 'es' })
    await bundle.close()
  `

// rspack's Node API is webpack's, so this is that driver with one name
// changed — including the CommonJS `require` form, since the `.default` hop is
// the same hop on both.
const RSPACK_DRIVER = `
    import { rspack } from '@rspack/core'
    import { createRequire } from 'node:module'
    const require = createRequire(import.meta.url)
    const { default: plugin } = require('@kanso-labs/unplugin-style-dictionary/rspack')
    await new Promise((resolve, reject) => {
      rspack(
        {
          entry: './entry.js',
          mode: 'development',
          output: { path: process.cwd() + '/dist' },
          plugins: [plugin({ config: CONFIG })],
        },
        (error, stats) => {
          if (error) return reject(error)
          const errors = stats?.toJson().errors ?? []
          if (errors.length > 0) return reject(new Error(errors[0]?.message ?? 'unknown'))
          resolve()
        },
      )
    })
  `

const VITE_DRIVER = `
    import { build } from 'vite'
    import plugin from '@kanso-labs/unplugin-style-dictionary/vite'
    await build({
      build: { lib: { entry: 'entry.js', fileName: 'out', formats: ['es'] }, outDir: 'dist' },
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin({ config: CONFIG })],
    })
  `

// The dev-server phase. Middleware mode so nothing binds a port, and HMR off
// so no websocket server outlives the phase — the same shape
// `tests/dev-server.test.ts` boots.
//
// The failure is printed as one line and the exit code set, rather than
// thrown: Node prints a thrown error beneath the source line it came from, and
// that line is what the parent would otherwise report.
const VITE_SERVE_DRIVER = `
    import fs from 'node:fs'
    import { createServer } from 'vite'
    import plugin from '@kanso-labs/unplugin-style-dictionary/vite'

    const generated = 'generated/tokens.js'
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const carries = (value) =>
      fs.existsSync(generated) && fs.readFileSync(generated, 'utf8').includes(value)

    const waitFor = async (value, what) => {
      const deadline = Date.now() + ${DEADLINE_MS}
      while (!carries(value)) {
        if (Date.now() > deadline) {
          throw new Error(what + ' within ${DEADLINE_MS / 1000}s')
        }
        await sleep(100)
      }
    }

    let server
    try {
      server = await createServer({
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin({ config: CONFIG })],
        server: { hmr: false, middlewareMode: true },
      })

      await waitFor(${JSON.stringify(EXPECTED)}, 'the dev server wrote no starting value')

      // chokidar reports nothing for a moment after the watcher is built, and
      // an edit landing inside that window is missed by the watcher rather
      // than by the plugin.
      await sleep(500)

      fs.writeFileSync(
        ${JSON.stringify(EDITED_FILE)},
        JSON.stringify({ color: { brand: { value: ${JSON.stringify(EDITED)} } } }),
      )
      await waitFor(${JSON.stringify(EDITED)}, 'the dev server did not regenerate after a token edit')
    } catch (error) {
      process.exitCode = 1
      console.error('dev server failed: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      await server?.close()
    }
  `

// The README's CommonJS form, because that is what a webpack.config.js looks
// like and the `.default` hop is the thing most likely to break.
const WEBPACK_DRIVER = `
    import webpack from 'webpack'
    import { createRequire } from 'node:module'
    const require = createRequire(import.meta.url)
    const { default: plugin } = require('@kanso-labs/unplugin-style-dictionary/webpack')
    await new Promise((resolve, reject) => {
      webpack(
        {
          entry: './entry.js',
          mode: 'development',
          output: { path: process.cwd() + '/dist' },
          plugins: [plugin({ config: CONFIG })],
        },
        (error, stats) => {
          if (error) return reject(error)
          const errors = stats?.toJson().errors ?? []
          if (errors.length > 0) return reject(new Error(errors[0]?.message ?? 'unknown'))
          resolve()
        },
      )
    })
  `

/**
 * The ends worth driving. `low` and `high` for a bounded range; a single entry
 * where the range is `*` and there is nothing to bound.
 *
 * Vite also gets its `middle` major, because each major of `^6 || ^7 || ^8` is
 * a dev server of its own and a `serve` driver runs on every one of them. Each
 * resolves to the newest release of its major rather than the floor: PR #302
 * chose that, since pinning `6.0.0` exactly tests a version nobody installs.
 *
 * style-dictionary rides on rollup rather than getting fixtures of its own:
 * it is the peer every target shares, so pinning it at each end of `^5` while
 * the bundler stays constant is what isolates it.
 *
 * One fixture's configuration is TypeScript, and it is the only place a `.ts`
 * config meets Node's own loader. The Vitest row for `.ts` never does: under
 * Vitest the plugin's `import()` goes through Vite's module runner, which
 * transpiles the file itself, so it passes where the built package cannot load
 * the file at all. Where `process.features.typescript` is off — Node 22 before
 * 22.18 — the documented failure is asserted instead, so the check never skips
 * without saying so.
 *
 * `versions` maps each package to the range it is resolved through, which
 * `resolveBeforeCutoff` holds to releases past Renovate's minimum age.
 * @type {{ bundler: string, config?: string, driver: string, end: string, serve?: string, versions: Record<string, string> }[]}
 */
const FIXTURES = [
  {
    bundler: 'vite',
    driver: VITE_DRIVER,
    end: 'low',
    serve: VITE_SERVE_DRIVER,
    versions: { vite: '^6.0.0' },
  },
  {
    bundler: 'vite',
    driver: VITE_DRIVER,
    end: 'middle',
    serve: VITE_SERVE_DRIVER,
    versions: { vite: '^7.0.0' },
  },
  {
    bundler: 'vite',
    driver: VITE_DRIVER,
    end: 'high',
    serve: VITE_SERVE_DRIVER,
    versions: { vite: '^8.0.0' },
  },
  {
    bundler: 'rollup',
    driver: ROLLUP_DRIVER,
    end: 'style-dictionary low',
    versions: { rollup: '*', 'style-dictionary': '5.0.0' },
  },
  {
    bundler: 'rollup',
    driver: ROLLUP_DRIVER,
    end: 'style-dictionary high',
    versions: { rollup: '*', 'style-dictionary': '^5.0.0' },
  },
  {
    bundler: 'rolldown',
    config: 'sd.config.ts',
    driver: ROLLDOWN_DRIVER,
    end: 'only, TypeScript config',
    versions: { rolldown: '*' },
  },
  {
    bundler: '@rspack/core',
    driver: RSPACK_DRIVER,
    end: 'only',
    versions: { '@rspack/core': '*' },
  },
  {
    bundler: 'webpack',
    driver: WEBPACK_DRIVER,
    end: 'only',
    versions: { webpack: '*' },
  },
]

/**
 * The most useful line of a failed child process. `catch` binds `unknown`, and
 * what `execFileSync` throws carries its output on `stderr` rather than in the
 * message — so a bare `error.message` reports `Command failed` and nothing a
 * reader can act on.
 * @param {unknown} error
 * @returns {string}
 */
function describeFailure(error) {
  /** @type {unknown} */
  const raw =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? error.stderr
      : undefined

  const stderr =
    typeof raw === 'string'
      ? raw.trim()
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8').trim()
        : ''

  const lines = stderr.split('\n').filter((line) => line.trim().length > 0)
  const named = lines.find((line) =>
    /error|cannot|failed|unresolved|ERESOLVE/i.test(line),
  )

  if (named) return named.trim()
  if (lines.length > 0) return lines[0].trim()

  return error instanceof Error ? error.message : String(error)
}

/**
 * The `version` of an installed package, read off its own manifest.
 * @param {string} manifestPath
 * @returns {string}
 */
function readInstalledVersion(manifestPath) {
  /** @type {unknown} */
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return 'unknown'

  const version = 'version' in parsed ? parsed.version : undefined
  return typeof version === 'string' ? version : 'unknown'
}

/**
 * What `npm pack --json` reports, narrowed from the `any` that `JSON.parse`
 * hands back.
 * @param {string} json
 * @returns {{ filename: string, files: unknown[] }}
 */
function readPackReport(json) {
  /** @type {unknown} */
  const parsed = JSON.parse(json)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack --json reported no tarball')
  }

  /** @type {unknown} */
  const first = parsed[0]
  if (typeof first !== 'object' || first === null) {
    throw new Error('npm pack --json reported an unexpected shape')
  }

  const filename = 'filename' in first ? first.filename : undefined
  const files = 'files' in first ? first.files : undefined
  if (typeof filename !== 'string' || !Array.isArray(files)) {
    throw new Error('npm pack --json reported an unexpected shape')
  }

  return { filename, files }
}

/**
 * What `npm view <name> time dist-tags --json` reports, narrowed from the
 * `any` that `JSON.parse` hands back.
 * @param {string} json
 * @returns {{ latest: string | undefined, time: Record<string, string> }}
 */
function readViewReport(json) {
  /** @type {unknown} */
  const parsed = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('npm view --json reported an unexpected shape')
  }

  /** @type {unknown} */
  const time = 'time' in parsed ? parsed.time : undefined
  /** @type {unknown} */
  const tags = 'dist-tags' in parsed ? parsed['dist-tags'] : undefined
  if (typeof time !== 'object' || time === null) {
    throw new Error('npm view --json reported no publish times')
  }

  /** @type {Record<string, string>} */
  const published = {}
  for (const [version, stamp] of Object.entries(time)) {
    if (typeof stamp === 'string') published[version] = stamp
  }

  /** @type {unknown} */
  const latest =
    typeof tags === 'object' && tags !== null && 'latest' in tags
      ? tags.latest
      : undefined

  return {
    latest: typeof latest === 'string' ? latest : undefined,
    time: published,
  }
}

/**
 * The version `range` resolves to among the releases of `name` published
 * before the cutoff. The `latest` tag where it qualifies, since npm prefers it
 * over a higher version under another tag, and otherwise the highest version
 * that does.
 *
 * Each range is resolved here and installed exactly, rather than handing npm
 * `--before`, because `--before` reaches the tarball's own exact pins too: a
 * runtime dependency bumped inside the window — a security fix, which
 * Dependabot raises and automerges with no waiting period — would stop every
 * install.
 * @param {string} name
 * @param {string} range
 * @returns {string}
 */
function resolveBeforeCutoff(name, range) {
  const { latest, time } = readViewReport(
    execFileSync('npm', ['view', name, 'time', 'dist-tags', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )

  /** @param {string} version */
  const qualifies = (version) =>
    semver.satisfies(version, range) &&
    Date.parse(time[version] ?? '') <= cutoff

  if (latest !== undefined && qualifies(latest)) return latest

  const highest = semver.maxSatisfying(
    Object.keys(time).filter(
      (version) => semver.valid(version) !== null && qualifies(version),
    ),
    range,
  )
  if (highest === null) {
    throw new Error(
      `no release of ${name} matching ${range} is ${MINIMUM_RELEASE_AGE_DAYS} days old yet`,
    )
  }

  return highest
}

/**
 * Runs one phase of a fixture and prints its line. A failure is recorded
 * rather than thrown, so a build that fails still leaves the dev server beside
 * it to report on its own.
 * @param {string} label
 * @param {() => string} phase returns what the `ok` line says after the label
 * @returns {void}
 */
function runPhase(label, phase) {
  try {
    const detail = phase()
    console.log(`  ok    ${label.padEnd(30)} ${detail}`)
  } catch (error) {
    console.log(`  FAIL  ${label}`)
    failures.push(`${label}: ${describeFailure(error)}`)
  }
}

/**
 * Writes a throwaway consumer: a token file, a Style Dictionary config, an
 * entry that re-exports a generated token, the driver that builds it, and the
 * driver that serves it where there is one.
 * @param {string} directory
 * @param {string} driver
 * @param {string} config the configuration's filename, `.json` or `.ts`
 * @param {string | undefined} serve
 * @returns {void}
 */
function writeFixture(directory, driver, config, serve) {
  fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })

  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'peer-fixture', private: true, type: 'module' }),
  )

  fs.writeFileSync(
    path.join(directory, 'tokens', 'color.json'),
    JSON.stringify({ color: { brand: { value: TOKEN } } }),
  )

  const configuration = {
    platforms: {
      js: {
        buildPath: 'generated/',
        files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
        transformGroup: 'js',
      },
    },
    source: ['tokens/**/*.json'],
  }

  // A `.ts` config carries type syntax Node has to strip — an `import type`
  // and a `satisfies` — so it cannot load as JavaScript by accident.
  fs.writeFileSync(
    path.join(directory, config),
    config.endsWith('.ts')
      ? [
          "import type { Config } from 'style-dictionary'",
          `export default ${JSON.stringify(configuration)} satisfies Config`,
          '',
        ].join('\n')
      : JSON.stringify(configuration),
  )

  // Re-exports a token rather than importing for side effects, so the
  // generated module cannot be tree-shaken out and a build that never wrote it
  // fails to resolve rather than quietly succeeding.
  fs.writeFileSync(
    path.join(directory, 'entry.js'),
    [
      "import { ColorBrand } from './generated/tokens.js'",
      'export const brand = ColorBrand',
      '',
    ].join('\n'),
  )

  fs.writeFileSync(
    path.join(directory, 'drive.mjs'),
    `const CONFIG = ${JSON.stringify(config)}\n${driver}`,
  )

  if (serve !== undefined) {
    fs.writeFileSync(
      path.join(directory, 'serve.mjs'),
      `const CONFIG = ${JSON.stringify(config)}\n${serve}`,
    )
  }
}

/** @type {string[]} */
const failures = []
const tarballDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-pack-'))

console.log('Packing the tarball...')
const packed = readPackReport(
  execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', tarballDirectory],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ),
)
const tarball = path.join(tarballDirectory, packed.filename)
console.log(`  ${packed.filename} (${packed.files.length} files)`)
console.log(
  `  peers published before ${new Date(cutoff).toISOString()}, ${MINIMUM_RELEASE_AGE_DAYS} days ago\n`,
)

// What a Node without type stripping says about a `.ts` config: Style
// Dictionary's own message, which README points at.
const NO_TYPE_STRIPPING = 'Could not import TypeScript file'

for (const {
  bundler,
  config = 'sd.config.json',
  driver,
  end,
  serve,
  versions,
} of FIXTURES) {
  const label = `${bundler} (${end})`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-peer-'))
  const expectsFailure = config.endsWith('.ts') && !process.features.typescript

  // Set once the install succeeds. The dev-server phase runs on any fixture
  // that got that far, whether or not its build passed.
  let installed = ''

  try {
    runPhase(label, () => {
      writeFixture(directory, driver, config, serve)

      const specifiers = Object.entries(versions).map(
        ([name, range]) => `${name}@${resolveBeforeCutoff(name, range)}`,
      )

      // `--ignore-scripts` matches every other install here, and keeps a
      // dependency's lifecycle hooks out of a check that exists to be trusted.
      execFileSync(
        'npm',
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          tarball,
          ...specifiers,
        ],
        { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      installed = readInstalledVersion(
        path.join(directory, 'node_modules', bundler, 'package.json'),
      )

      if (expectsFailure) {
        let failure = ''
        try {
          execFileSync(process.execPath, ['drive.mjs'], {
            cwd: directory,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          failure =
            typeof error === 'object' && error !== null && 'stderr' in error
              ? String(error.stderr)
              : String(error)
        }

        if (!failure.includes(NO_TYPE_STRIPPING)) {
          throw new Error(
            `without type stripping, expected "${NO_TYPE_STRIPPING}", got: ${failure || 'a build that succeeded'}`,
          )
        }

        return `${bundler}@${installed}, fails as documented without type stripping`
      }

      execFileSync(process.execPath, ['drive.mjs'], {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const generated = path.join(directory, 'generated', 'tokens.js')
      if (!fs.existsSync(generated)) {
        throw new Error('the build wrote no generated file')
      }

      const contents = fs.readFileSync(generated, 'utf8')
      if (!contents.includes(EXPECTED)) {
        throw new Error(`the generated file does not carry ${EXPECTED}`)
      }

      return `${bundler}@${installed}`
    })

    if (serve === undefined || installed === '') continue

    runPhase(`${bundler} (${end}, dev server)`, () => {
      // The driver waits on its own deadline for each regeneration; this
      // timeout is the backstop for a server whose `close()` never returns,
      // which would otherwise hold `Build` until the job is killed.
      execFileSync(process.execPath, ['serve.mjs'], {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEADLINE_MS * 3,
      })

      const contents = fs.readFileSync(
        path.join(directory, 'generated', 'tokens.js'),
        'utf8',
      )
      if (!contents.includes(EDITED)) {
        throw new Error(`the generated file does not carry ${EDITED}`)
      }

      return `${bundler}@${installed}, rebuilt on a token edit`
    })
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

fs.rmSync(tarballDirectory, { force: true, recursive: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} peer end(s) failed:\n`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  '\nEvery declared peer end builds, and every Vite major rebuilds a token edit under its dev server.',
)
