// Whether a configuration's compile can be skipped, and the destinations that
// question is asked about.
//
// Nothing here holds state — not even the record of which configuration last
// wrote each destination, which is process-wide and lives in `index.ts` beside
// `compilesInFlight`. What a plugin instance owns is handed in on each call.

import type { Config } from 'style-dictionary'

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Log, ResolvedConfig } from './config.js'
import type { UnpluginStyleDictionaryOptions } from './types.js'

import {
  expandPatterns,
  sourcePatternsOf,
  watchOptionPatterns,
} from './patterns.js'

// What this process knows about the compile that last wrote one destination:
// which configuration it was, and the newest source it saw before it read any
// of them. `newestSource` is `null` where that compile did not look, which is
// when `cache` was off or the sources could not be established.
export interface DestinationRecord {
  fingerprint: string
  newestSource: null | number
}

// A stable identity for one resolved configuration, or `null` where it
// cannot have one. Functions are serialised by source rather than dropped,
// because an inline `format` or `transform` is exactly the edit a
// fingerprint has to notice, and `JSON.stringify` omits a function outright.
//
// A digest of that serialisation rather than the serialisation itself,
// because it is held against every destination a build writes, and a
// configuration carrying its tokens inline serialises to all of them.
export function configFingerprint(
  root: string,
  item: ResolvedConfig,
): null | string {
  let serialised: string
  try {
    serialised = JSON.stringify(
      [root, item.file ?? item.config],
      (_key, value: unknown) =>
        typeof value === 'function' ? `[fn]${String(value)}` : value,
    )
  } catch {
    // Circular, or holding a BigInt. It takes no identity rather than a
    // wrong one, so it compiles every time exactly as it did before.
    return null
  }

  return createHash('sha256').update(serialised).digest('hex')
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

// Whether a configuration's compile can be skipped: every file it declares
// exists, and nothing it reads has changed since the compile that wrote them.
//
// "Since" is measured against what that compile read wherever this process
// ran it. Its record holds the newest source it saw before reading, and a
// source newer than that is one it never read. Comparing against the output
// instead, as a first compile still has to, lost a save that landed while a
// rebuild ran: the rebuild wrote its output after the save, so the output was
// newer than an edit it never read, and the follow-up the scheduler queued
// for that save was skipped as up to date.
//
// Conservative in every direction it can be: anything it cannot establish —
// a destination that is missing, a source it cannot stat, a configuration
// declaring no destinations at all — is a reason to build rather than to
// skip.
export function isUpToDate(
  {
    destinationRecords,
    root,
  }: {
    destinationRecords: ReadonlyMap<string, DestinationRecord>
    root: string
  },
  item: ResolvedConfig,
  configObj: Config,
  newestSource: null | number,
  only?: string[],
): boolean {
  // An action writes what no `destination` names, so there is nothing for
  // the comparison below to check and skipping would leave its work undone.
  const hasActions = Object.values(configObj.platforms ?? {}).some(
    (platform) => (platform.actions?.length ?? 0) > 0,
  )
  if (hasActions) return false

  const destinations = declaredDestinations(configObj, only)
  if (destinations.length === 0) return false

  if (newestSource === null) return false

  const fingerprint = configFingerprint(root, item)

  for (const destination of destinations) {
    const stats = statOrNull(destination)
    if (!stats) return false

    const record = destinationRecords.get(destination)
    const writtenByThis =
      fingerprint !== null && record?.fingerprint === fingerprint

    // A configuration given as a path has its own file among the sources, so
    // an edit to it is accounted for and the skip holds across processes. One
    // given as an object or a function has not, and only this process knows
    // which configuration last wrote each destination — so it skips only over
    // files this one wrote. Having built it at some point is not enough: an
    // edit that was then undone left the edit's output standing, and so did a
    // build of it that threw partway.
    if (!item.file && !writtenByThis) return false

    const lastRead = writtenByThis ? record.newestSource : null

    if (
      lastRead === null
        ? stats.mtimeMs <= newestSource
        : newestSource > lastRead
    ) {
      return false
    }
  }

  return true
}

// The newest mtime among the files a configuration reads, or `null` where that
// cannot be established: a source that cannot be stat'ed, or patterns that
// matched no file at all.
//
// Asked before a compile reads anything, and recorded against what it writes,
// so that the next `isUpToDate` compares against what the compile actually
// read. A save that lands afterwards is newer than this, however much newer
// the compile's own output turns out to be. Both sides of that comparison are
// mtimes of the files themselves, so no clock is involved and nothing depends
// on how finely the filesystem stamps a write.
export async function newestSourceOf(
  {
    log,
    root,
    watch,
  }: {
    log: Log
    root: string
    watch: UnpluginStyleDictionaryOptions['watch']
  },
  item: ResolvedConfig,
  configObj: Config,
): Promise<null | number> {
  // `options.watch` belongs in here as much as `source` does. A consumer
  // names an extra file because something in the build reads it — a custom
  // format's own data file, most obviously — and leaving it out let a change
  // to it be skipped over while the watcher dutifully reported it.
  const read = sourcePatternsOf(configObj)
  const extra = watchOptionPatterns(root, watch)

  const sources = await expandPatterns(
    {
      globs: [...read.globs, ...extra.globs],
      literals: [...read.literals, ...extra.literals],
    },
    log,
  )
  if (item.file) sources.push(item.file.replace(/\\/g, '/'))

  if (sources.length === 0) return null

  let newestSource = -Infinity
  let sawFile = false

  for (const source of sources) {
    const stats = statOrNull(source)
    if (!stats) return null

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
  return sawFile ? newestSource : null
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
  return path.resolve(
    process.cwd(),
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
