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
// documents. Rewriting `default` to `import` on all five entries still gives
// publint "All good!".
//
// The second is what a require() of a target entry hands back. Node serves it
// through require(esm), so the caller gets the module namespace rather than
// the default export, and the README tells consumers to destructure
// `.default` out of it. That has not always held: while the package still
// shipped a CommonJS build, tsdown's `cjsDefault` rewrote these four entries
// to `module.exports = fn` and a require() gave the function directly.
// Nothing but this keeps the README and the package agreeing.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const packageName = '@kanso-labs/unplugin-style-dictionary'

// Each target entry is `export default unplugin.<target>` over the same
// factory, so all four are checked identically.
const targets = ['rolldown', 'rollup', 'vite', 'webpack']

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

check('the main entry evaluates under require()', () => {
  const namespace = requireNamespace(packageName)

  for (const name of ['default', 'matchesWatchedFile', 'unpluginFactory']) {
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
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log('\nAll good!')
