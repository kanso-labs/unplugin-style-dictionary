#!/usr/bin/env node
// Drives the ends of every declared peer range against the packed tarball.
//
// `package.json` makes five compatibility claims — `vite ^6 || ^7 || ^8`,
// `style-dictionary ^5`, and `*` for rollup, rolldown and webpack — and until
// this existed nothing stood behind any of them. `tests/targets.test.ts` drives
// all four bundlers, which covers the adapters, but only against the single
// version `devDependencies` pins: it cannot see a range end going stale.
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

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname

// Every fixture writes this, and every fixture asserts on it.
//
// A JavaScript format rather than CSS: rollup and rolldown cannot resolve a
// `.css` import without a loader plugin, and what is under test is this
// package's entry points, not anyone's css handling. A JS module is the one
// shape all four bundlers take unaided.
const TOKEN = '#0070f3'
const EXPECTED = '#0070f3'

// One driver per bundler, named rather than looked up by key: a computed
// lookup is untypeable here and the guard it needs is noise beside six
// constants.
const ROLLDOWN_DRIVER = `
    import { rolldown } from 'rolldown'
    import plugin from '@kanso-labs/unplugin-style-dictionary/rolldown'
    const bundle = await rolldown({ input: 'entry.js', plugins: [plugin({ config: 'sd.config.json' })] })
    await bundle.generate({ format: 'es' })
    await bundle.close()
  `

const ROLLUP_DRIVER = `
    import { rollup } from 'rollup'
    import plugin from '@kanso-labs/unplugin-style-dictionary/rollup'
    const bundle = await rollup({ input: 'entry.js', plugins: [plugin({ config: 'sd.config.json' })] })
    await bundle.generate({ format: 'es' })
    await bundle.close()
  `

const VITE_DRIVER = `
    import { build } from 'vite'
    import plugin from '@kanso-labs/unplugin-style-dictionary/vite'
    await build({
      build: { lib: { entry: 'entry.js', fileName: 'out', formats: ['es'] }, outDir: 'dist' },
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin({ config: 'sd.config.json' })],
    })
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
          plugins: [plugin({ config: 'sd.config.json' })],
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
 * style-dictionary rides on rollup rather than getting fixtures of its own:
 * it is the peer every target shares, so pinning it at each end of `^5` while
 * the bundler stays constant is what isolates it.
 */
const FIXTURES = [
  {
    bundler: 'vite',
    driver: VITE_DRIVER,
    end: 'low',
    versions: { vite: '^6.0.0' },
  },
  {
    bundler: 'vite',
    driver: VITE_DRIVER,
    end: 'high',
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
    driver: ROLLDOWN_DRIVER,
    end: 'only',
    versions: { rolldown: '*' },
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
 * Writes a throwaway consumer: a token file, a Style Dictionary config, an
 * entry that re-exports a generated token, and the driver that builds it.
 * @param {string} directory
 * @param {string} driver
 * @returns {void}
 */
function writeFixture(directory, driver) {
  fs.mkdirSync(path.join(directory, 'tokens'), { recursive: true })

  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'peer-fixture', private: true, type: 'module' }),
  )

  fs.writeFileSync(
    path.join(directory, 'tokens', 'color.json'),
    JSON.stringify({ color: { brand: { value: TOKEN } } }),
  )

  fs.writeFileSync(
    path.join(directory, 'sd.config.json'),
    JSON.stringify({
      platforms: {
        js: {
          buildPath: 'generated/',
          files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
          transformGroup: 'js',
        },
      },
      source: ['tokens/**/*.json'],
    }),
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

  fs.writeFileSync(path.join(directory, 'drive.mjs'), driver)
}

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
console.log(`  ${packed.filename} (${packed.files.length} files)\n`)

for (const { bundler, driver, end, versions } of FIXTURES) {
  const label = `${bundler} (${end})`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-peer-'))

  try {
    writeFixture(directory, driver)

    const specifiers = Object.entries(versions).map(
      ([name, range]) => `${name}@${range}`,
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

    const installed = readInstalledVersion(
      path.join(directory, 'node_modules', bundler, 'package.json'),
    )

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

    console.log(`  ok    ${label.padEnd(30)} ${bundler}@${installed}`)
  } catch (error) {
    console.log(`  FAIL  ${label}`)
    failures.push(`${label}: ${describeFailure(error)}`)
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

console.log('\nEvery declared peer end builds.')
