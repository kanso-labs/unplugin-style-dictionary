// Whether a configuration's compile can be skipped, and the destinations that
// question is asked about.
//
// Nothing here holds state — not even the fingerprints of what this process
// has compiled, which are process-wide and live in `index.ts` beside
// `compilesInFlight`. What a plugin instance owns is handed in on each call.

import type { Config } from 'style-dictionary'

import fs from 'node:fs'
import path from 'node:path'

import type { Log, ResolvedConfig } from './config.js'
import type { UnpluginStyleDictionaryOptions } from './types.js'

import { expandPatterns, sourcePatternsOf } from './patterns.js'

// A stable identity for one resolved configuration, or `null` where it
// cannot have one. Functions are serialised by source rather than dropped,
// because an inline `format` or `transform` is exactly the edit a
// fingerprint has to notice, and `JSON.stringify` omits a function outright.
export function configFingerprint(
  root: string,
  item: ResolvedConfig,
): null | string {
  try {
    return JSON.stringify(
      [root, item.file ?? item.config],
      (_key, value: unknown) =>
        typeof value === 'function' ? `[fn]${String(value)}` : value,
    )
  } catch {
    // Circular, or holding a BigInt. It takes no identity rather than a
    // wrong one, so it compiles every time exactly as it did before.
    return null
  }
}

// Every absolute destination a configuration declares, read off the
// configuration itself rather than off an extended Style Dictionary
// instance. Reading it here is the whole point: constructing the instance
// is what the skip exists to avoid.
//
// Each one is named by `writtenDestination`, which `runBuilds` asks as well,
// so the up-to-date check and the record of what was built name the same
// files — the ones Style Dictionary actually wrote.
//
// `only` narrows this to named platforms, and exactly one caller wants that:
// the up-to-date check, which asks whether the work *this* compile would do
// is already done. Everywhere else the answer has to cover every declared
// platform, because a file an unselected platform wrote earlier is still the
// plugin's own output and has to stay out of the watch list.
export function declaredDestinations(
  configObj: Config,
  only?: string[],
): string[] {
  const destinations: string[] = []

  const entries = Object.entries(configObj.platforms ?? {})
  const selected = only
    ? entries.filter(([name]) => only.includes(name))
    : entries

  for (const [, platform] of selected) {
    for (const file of platform.files ?? []) {
      if (file.destination) {
        destinations.push(
          writtenDestination(platform.buildPath, file.destination),
        )
      }
    }
  }

  return destinations
}

// Whether every file a configuration declares is already newer than every
// file it reads, so its compile can be skipped.
//
// Conservative in every direction it can be: anything it cannot establish —
// a destination that is missing, a source it cannot stat, a configuration
// declaring no destinations at all — is a reason to build rather than to
// skip.
export async function isUpToDate(
  {
    compiledFingerprints,
    log,
    root,
    watch,
  }: {
    compiledFingerprints: ReadonlySet<string>
    log: Log
    root: string
    watch: UnpluginStyleDictionaryOptions['watch']
  },
  item: ResolvedConfig,
  configObj: Config,
  only?: string[],
): Promise<boolean> {
  // An action writes what no `destination` names, so there is nothing for
  // the comparison below to check and skipping would leave its work undone.
  const hasActions = Object.values(configObj.platforms ?? {}).some(
    (platform) => (platform.actions?.length ?? 0) > 0,
  )
  if (hasActions) return false

  const destinations = declaredDestinations(configObj, only)
  if (destinations.length === 0) return false

  // `options.watch` belongs in here as much as `source` does. A consumer
  // names an extra file because something in the build reads it — a custom
  // format's own data file, most obviously — and leaving it out let a change
  // to it be skipped over while the watcher dutifully reported it.
  const extraWatches = watch ? (Array.isArray(watch) ? watch : [watch]) : []

  const sources = await expandPatterns(
    [
      ...sourcePatternsOf(configObj),
      ...extraWatches.map((pattern) =>
        (path.isAbsolute(pattern)
          ? pattern
          : path.resolve(root, pattern)
        ).replace(/\\/g, '/'),
      ),
    ],
    log,
  )
  if (item.file) sources.push(item.file.replace(/\\/g, '/'))

  if (sources.length === 0) return false

  let newestSource = -Infinity
  let sawFile = false

  for (const source of sources) {
    const stats = statOrNull(source)
    if (!stats) return false

    // Directories are in this list on purpose — `expandPatterns` registers
    // each pattern's static parent so a token file created later is
    // noticed — but their mtime cannot be read as an input signal here. A
    // directory's mtime moves whenever an entry is added or renamed inside
    // it, and the atomic write renames every generated file into place, so
    // a `buildPath` inside a watched directory made the build itself the
    // newest thing the comparison could see. Nothing was ever up to date.
    if (stats.isDirectory()) continue

    sawFile = true
    newestSource = Math.max(newestSource, stats.mtimeMs)
  }

  // Every pattern expanded to directories alone, so nothing was actually
  // read. Style Dictionary would build an empty dictionary from that, and a
  // skip would present the empty result as current.
  if (!sawFile) return false

  let oldestDestination = Infinity
  for (const destination of destinations) {
    const stats = statOrNull(destination)
    if (!stats) return false
    oldestDestination = Math.min(oldestDestination, stats.mtimeMs)
  }

  if (oldestDestination <= newestSource) return false

  // A configuration given as a path has its own file among the sources
  // above, so an edit to it has already been accounted for and the skip
  // holds across processes.
  if (item.file) return true

  // One given as an object or a function has not. Only this process knows
  // what it looked like when those destinations were written, so the skip
  // holds only against a fingerprint recorded here.
  const fingerprint = configFingerprint(root, item)

  return fingerprint !== null && compiledFingerprints.has(fingerprint)
}

// Where Style Dictionary writes one file, as an absolute path.
//
// It joins the destination onto the platform's `buildPath` when there is one
// and writes the result relative to the working directory. **Joins, not
// resolves**: an absolute destination lands under the build path rather than
// replacing it. Measured with `buildPath: 'gen/'` and an absolute destination,
// Style Dictionary wrote `gen/<that path>`, while the plugin had named the
// absolute path on its own — a file that was never written.
//
// `root` has no say. It is where a relative `config` path is looked up and
// nothing more, and reading `buildPath` against it named files that did not
// exist whenever the two differed (#362). Style Dictionary joins with
// `path-unified/posix`; the platform's own `join` names the same file, and
// resolving the result is what normalises the separators either way.
export function writtenDestination(
  buildPath: string | undefined,
  destination: string,
): string {
  // TEMPORARY, for #368: a base other than the working directory, standing in
  // for the `root` reading #362 removed. Reverted before this merges.
  return path.resolve(
    path.dirname(process.cwd()),
    buildPath ? path.join(buildPath, destination) : destination,
  )
}

// `fs.statSync` without the throw. A file that is missing, or that cannot be
// read, is the same answer to every caller here: nothing to compare against.
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}
