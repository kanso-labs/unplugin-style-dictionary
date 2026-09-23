// The two things one compile decides from the plugin's options: which
// platforms it builds, and whether a failure stops the host. Both turn on
// `context`, which only the rebuild paths pass, and on an option the caller
// hands in rather than one held here.

import type { UnpluginStyleDictionaryOptions } from './types.js'

// Whether a failure in this compile should be thrown rather than only
// reported. The two compiles are told apart by `runBuilds`'s `context`,
// which only the rebuild paths pass.
export function failsTheBuild(
  failOnError: NonNullable<UnpluginStyleDictionaryOptions['failOnError']>,
  context: string | undefined,
): boolean {
  return (
    failOnError === true ||
    (context === undefined ? failOnError === 'build' : failOnError === 'serve')
  )
}

// Which platforms this compile covers, or `undefined` for all of them.
//
// The array form applies to every build; the object form splits the first
// compile from the watch rebuilds, and `context` is what tells them apart —
// only the rebuild paths pass one. An absent key means every platform, so
// `{ watch: ['css'] }` builds everything once and then only css.
export function platformsFor(
  platformsOption: UnpluginStyleDictionaryOptions['platforms'],
  context: string | undefined,
): string[] | undefined {
  if (platformsOption === undefined) return undefined
  if (Array.isArray(platformsOption)) return platformsOption

  return context === undefined ? platformsOption.build : platformsOption.watch
}
