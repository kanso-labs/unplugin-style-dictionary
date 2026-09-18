#!/usr/bin/env node
// Checks the two things about the built package that publint cannot see.
//
// publint reads package.json and the packed file list, so it catches an
// exports target pointing at a file that is not there — which is what
// removing `fixedExtension: false` from tsdown.config.ts produces, since the
// build then emits `.mjs` while every condition here names `.js`. But it
// never asks Node to resolve anything and never evaluates a module, which
// leaves two failures it reports as "All good!".
//
// The first is the exports map's `default` condition. It is what lets a
// require() reach this ESM-only package at all: under `import` instead, the
// same call fails with ERR_PACKAGE_PATH_NOT_EXPORTED and every CommonJS
// consumer is dropped — a webpack.config.js being the case the README
// documents. Rewriting `default` to `import` on all six entries still gives
// publint "All good!".
//
// The second is what a require() of a target entry hands back. Node serves it
// through require(esm), so the caller gets the module namespace rather than
// the default export, and the README tells consumers to destructure
// `.default` out of it. That has not always held: while the package still
// shipped a CommonJS build, tsdown's `cjsDefault` rewrote these four entries
// to `module.exports = fn` and a require() gave the function directly.
// Nothing but this keeps the README and the package agreeing.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import semver from 'semver'

const require = createRequire(import.meta.url)

/**
 * A package manifest, read from disk rather than through `require`. A
 * dependency's own `package.json` is not reliably reachable as a specifier —
 * `require('style-dictionary/package.json')` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED, because its exports map does not list it.
 * @param {string} relativePath
 * @returns {{
 *   engines?: { node?: string }
 *   peerDependencies?: Record<string, string>
 *   peerDependenciesMeta?: Record<string, { optional?: boolean }>
 * }}
 */
function readManifest(relativePath) {
  const url = new URL(relativePath, import.meta.url)
  /** @type {unknown} */
  const parsed = JSON.parse(fs.readFileSync(url, 'utf-8'))

  // `JSON.parse` hands back `any`, so the shape is narrowed once here rather
  // than trusted by every read below.
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(`${relativePath} did not parse to an object`)
  }

  return parsed
}

const packageName = '@kanso-labs/unplugin-style-dictionary'

// Each target entry is `export default unplugin.<target>` over the same
// factory, so all five are checked identically.
const targets = ['rolldown', 'rollup', 'rspack', 'vite', 'webpack']

/** @type {string[]} */
const failures = []

/**
 * @param {string} description
 * @param {() => void} assertion
 */
function check(description, assertion) {
  try {
    assertion()
    console.log(`  ok    ${description}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${description}\n          ${message}`)
    console.log(`  FAIL  ${description}`)
  }
}

/**
 * Node types `require()` as `any`, so what comes back is narrowed here rather
 * than trusted by every caller below.
 * @param {string} specifier
 * @returns {object}
 */
function requireNamespace(specifier) {
  /** @type {unknown} */
  const namespace = require(specifier)

  if (typeof namespace !== 'object' || namespace === null) {
    throw new TypeError(`required the module and got ${typeof namespace} back`)
  }

  return namespace
}

/**
 * @param {string} specifier
 * @param {string} expected
 */
function resolvesTo(specifier, expected) {
  const resolved = require.resolve(specifier).replaceAll('\\', '/')

  if (!resolved.endsWith(expected)) {
    throw new Error(
      `resolved to ${resolved}, expected it to end with ${expected}`,
    )
  }
}

console.log('Checking what publint cannot see...')

// Nothing here imports a stylesheet or anything else plain Node cannot load,
// so every entry is both resolved and evaluated: resolving is what `default`
// decides, and evaluating is what proves require(esm) genuinely works rather
// than merely pointing at a file that exists.
check('the main entry resolves under require()', () => {
  resolvesTo(packageName, '/dist/index.js')
})

// A declared `engines.node` admitting a Node a required peer refuses is a
// claim nothing else checks. `^20.19.0 || >=22.12.0` said Node 20 was
// supported while the required `style-dictionary` peer declares `>=22.0.0` —
// so npm warned EBADENGINE on every Node 20 install, and refused it outright
// under `engine-strict=true`, while this package's own metadata invited it.
//
// `subset` rather than `intersects`, and the difference is the whole check:
// `intersects` asks whether *some* version satisfies both, which the broken
// range passed on the strength of its `>=22.12.0` half alone. What has to hold
// is that *every* version this package admits is one the peer admits too.
//
// Read from the installed copy rather than the registry, so the check needs no
// network and answers for the versions actually resolved here. Optional peers
// are skipped: a consumer who never installs one is never subject to its
// floor, which is the whole meaning of the `peerDependenciesMeta` entry.
check('engines.node admits no Node a required peer refuses', () => {
  const manifest = readManifest('../package.json')
  const declared = manifest.engines?.node

  if (typeof declared !== 'string') {
    throw new Error('package.json declares no engines.node')
  }

  const peers = manifest.peerDependencies ?? {}
  const optional = manifest.peerDependenciesMeta ?? {}
  /** @type {string[]} */
  const conflicts = []

  for (const peer of Object.keys(peers)) {
    if (optional[peer]?.optional === true) continue

    const peerEngines = readManifest(`../node_modules/${peer}/package.json`)
      .engines?.node

    if (typeof peerEngines !== 'string') continue

    if (!semver.subset(declared, peerEngines, { loose: true })) {
      conflicts.push(
        `${peer} requires node ${peerEngines}, which does not admit every version of ${declared}`,
      )
    }
  }

  if (conflicts.length > 0) {
    throw new Error(conflicts.join('; '))
  }
})

check('the main entry evaluates under require()', () => {
  const namespace = requireNamespace(packageName)

  for (const name of ['default']) {
    if (!(name in namespace)) {
      throw new Error(`required the module and got no \`${name}\` export back`)
    }
  }
})

for (const target of targets) {
  check(`the ./${target} subpath resolves under require()`, () => {
    resolvesTo(`${packageName}/${target}`, `/dist/${target}.js`)
  })

  // The README's `const { default: StyleDictionary } = require(...)`. A
  // namespace without a callable `default` means that documented form has
  // stopped working, whatever else still resolves.
  check(`the ./${target} subpath evaluates to a { default } namespace`, () => {
    const namespace = requireNamespace(`${packageName}/${target}`)

    if (!('default' in namespace)) {
      throw new Error('the namespace carries no `default`')
    }

    if (typeof namespace.default !== 'function') {
      throw new Error(`\`default\` is ${typeof namespace.default}`)
    }
  })

  // The options type is erased at runtime, so no `require` or import can see
  // whether a consumer could have named it — only the emitted declaration
  // says. Reading the built file rather than the source is the point: this
  // package has twice shipped declarations that did not match what the source
  // implied, once when `fixedExtension: false` was dropped and once when a
  // CommonJS build rewrote the target entries, and both were invisible until
  // something read `dist/`.
  check(`the ./${target} subpath declares the options type`, () => {
    const declaration = fs.readFileSync(
      new URL(`../dist/${target}.d.ts`, import.meta.url),
      'utf-8',
    )

    if (!declaration.includes('UnpluginStyleDictionaryOptions')) {
      throw new Error('the declaration never mentions the options type')
    }

    // Naming it in the plugin's own signature is not the same as exporting
    // it, and the signature import is what made this look fine for so long.
    if (
      !/export\s*\{[^}]*\btype UnpluginStyleDictionaryOptions\b/.test(
        declaration,
      )
    ) {
      throw new Error(
        'the options type is imported for the signature but never exported',
      )
    }
  })
}

// Every generated source map carries the original TypeScript inline.
//
// `files` ships `dist` alone, so `sources` naming `../src/index.ts` points at a
// path that exists nowhere on a consumer's disk. What makes a stack trace
// readable there is `sourcesContent`: installed from the packed tarball and made
// to throw from inside the plugin, `node --enable-source-maps` prints the
// original TypeScript code frame. With only `sourcesContent` removed from that
// same map, the frame degrades to the generated JavaScript while the stack still
// names the dangling `src/` path.
//
// **This guards a deliberate future addition rather than an accidental
// deletion**, which makes it a weaker case than the `fixedExtension` and
// `default`-condition checks above. tsdown types `sourcemap` as
// `boolean | 'inline' | 'hidden'`, so nothing in that option can drop the
// content — it would take a new `outputOptions.sourcemapExcludeSources` entry
// that `tsdown.config.ts` does not have. Neither publint nor attw looks at a
// map at all: publint's source carries no reference to `sourcemap`,
// `sourcesContent` or `sourceMappingURL`.
// `toSorted` rather than `sort`, which is what the linter asks for and what
// `src/index.ts` cannot use: `tsconfig.test.json` covers this directory at
// ES2023, where `tsconfig.lib.json` is ES2022.
const maps = fs
  .readdirSync('dist')
  .filter((file) => file.endsWith('.js.map'))
  .toSorted((left, right) => left.localeCompare(right))

if (maps.length === 0) {
  failures.push('dist carries no source maps at all')
}

for (const file of maps) {
  check(`${file} embeds its original source`, () => {
    /** @type {unknown} */
    const parsed = JSON.parse(fs.readFileSync(path.join('dist', file), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('is not an object')
    }

    const sources = 'sources' in parsed ? parsed.sources : undefined
    const contents =
      'sourcesContent' in parsed ? parsed.sourcesContent : undefined

    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('names no sources')
    }

    if (!Array.isArray(contents)) {
      throw new Error(
        'has no sourcesContent, so a consumer gets a stack trace pointing at a src/ path that is not shipped',
      )
    }

    if (contents.length !== sources.length) {
      throw new Error(
        `names ${sources.length} source(s) but carries ${contents.length} sourcesContent entr(ies)`,
      )
    }

    const missing = sources.filter(
      (_, index) =>
        typeof contents[index] !== 'string' || contents[index] === '',
    )

    if (missing.length > 0) {
      throw new Error(`carries no content for ${missing.join(', ')}`)
    }
  })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log('\nAll good!')
