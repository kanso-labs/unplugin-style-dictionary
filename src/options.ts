// The options whose values a consumer can get wrong without anything saying
// so, checked once when the plugin is created.
//
// The types rule these values out, but only in a typed config: the README's
// CommonJS webpack config and any JavaScript Vite or rollup config are not
// checked. Unchecked, each wrong value was read as whatever it came closest
// to. `failOnError: 'always'`, or the string `'true'` from an environment
// variable, behaved as `false`, so a broken build exited 0. `platforms: 'js'`
// and `platforms: { serve: ['js'] }` built every platform.
//
// `watch` is not here: a non-string entry already throws from `path` the first
// time a watch list is derived. Nothing here holds state.

import { inspect } from 'node:util'

const FAIL_ON_ERROR = new Set<unknown>(['build', false, 'serve', true])
const LOG_LEVELS = new Set<unknown>(['info', 'silent', 'verbose', 'warn'])

// Throws a `TypeError` naming the option, what it accepts and what it was
// given, for the first option whose value is outside its declared type.
export function checkOptions(options: object): void {
  const failOnError = read(options, 'failOnError')
  if (failOnError !== undefined && !FAIL_ON_ERROR.has(failOnError)) {
    reject('failOnError', "true, false, 'build' or 'serve'", failOnError)
  }

  // An unknown level fell through to the plugin's progress lines and Style
  // Dictionary's default verbosity: noisier rather than less safe, and checked
  // for consistency. `'error'` is the likely one, and there is no such level.
  const logLevel = read(options, 'logLevel')
  if (logLevel !== undefined && !LOG_LEVELS.has(logLevel)) {
    reject('logLevel', "'silent', 'warn', 'info' or 'verbose'", logLevel)
  }

  const platforms = read(options, 'platforms')
  if (platforms !== undefined && !isPlatformSelection(platforms)) {
    reject(
      'platforms',
      'an array of platform names, or an object with only `build` and `watch` arrays',
      platforms,
    )
  }
}

function isNameList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((name: unknown) => typeof name === 'string')
  )
}

// An array of names, or an object keyed by `build` and `watch` alone. `serve`
// is the slip worth catching: `failOnError` says `'serve'` where this says
// `watch`, and an object with an unknown key built every platform, as though
// nothing had been selected.
function isPlatformSelection(value: unknown): boolean {
  if (isNameList(value)) return true
  if (typeof value !== 'object' || value === null) return false

  return Object.entries(value).every(
    ([key, names]) =>
      (key === 'build' || key === 'watch') &&
      (names === undefined || isNameList(names)),
  )
}

// Read structurally, so the check sees what was passed rather than what the
// type says was.
function read(options: object, key: string): unknown {
  return Reflect.get(options, key)
}

function reject(name: string, accepts: string, received: unknown): never {
  throw new TypeError(
    `[unplugin-style-dictionary] The ${name} option must be ${accepts}, and was ${inspect(received)}.`,
  )
}
