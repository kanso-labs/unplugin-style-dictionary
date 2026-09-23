// The `source` and `include` patterns a configuration reads, the watch list
// derived from them, and the paths a watcher is actually handed for it.
//
// Nothing here holds state. What a plugin instance owns — its root, its
// logger, its `watch` option — is handed in on each call.

import type { Config } from 'style-dictionary'

import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'

import type { Log, ResolvedConfig } from './config.js'
import type { UnpluginStyleDictionaryOptions } from './types.js'

import { readConfigObject } from './config.js'
import { errorMessage } from './errors.js'

// A pattern is a glob when any of these appear in it. Deliberately the set
// picomatch and tinyglobby act on, since those two are what match and expand
// here — a path containing one of these characters literally is not
// distinguishable from a pattern, and would not be matchable either.
const GLOB_CHARACTERS = /[!*?[\]{}]/

// What a watcher is handed, and what a changed path is tested against, are
// not the same list, and conflating them is why a glob source was watched by
// nothing at all. Every watcher in play takes filenames rather than
// patterns: Vite's chokidar and rollup's `FileWatcher` are both constructed
// with `disableGlobbing: true`, Vite's `addWatchFile` drops anything that
// fails `fs.existsSync`, and webpack never globs `fileDependencies`. So the
// patterns stay for matching and the paths are expanded for registering.
export async function expandPatterns(
  patterns: string[],
  log: Log,
): Promise<string[]> {
  const paths = new Set<string>()
  const globs: string[] = []

  for (const pattern of patterns) {
    if (GLOB_CHARACTERS.test(pattern)) {
      globs.push(pattern)

      // Watching the directory as well as its current contents. chokidar
      // reports a creation inside a watched directory, which is the only
      // way a token file added later is ever noticed.
      const parent = staticParentOf(pattern)
      if (parent && fs.existsSync(parent)) paths.add(parent)
    } else {
      paths.add(pattern)
    }
  }

  if (globs.length > 0) {
    try {
      // tinyglobby matches with picomatch, which is what
      // `matchesWatchedFile` tests with, so what is registered here and what
      // is accepted there cannot disagree.
      for (const match of await glob(globs, { absolute: true })) {
        paths.add(match.replace(/\\/g, '/'))
      }
    } catch (err) {
      log(`Failed to expand watch patterns: ${errorMessage(err)}`, 'error')
    }
  }

  return Array.from(paths)
}

// Which of a configuration's own `source`/`include` patterns match no file on
// disk. Only for diagnosis: it is the emptiness of the resolved token set that
// decides whether a build fails, because only that catches every route to an
// empty set. This names the pattern at fault, which the token count cannot, and
// it reports a mistyped pattern in a configuration whose others still match —
// where nothing fails at all and one platform quietly loses its tokens.
export async function patternsMatchingNothing(
  patterns: string[],
): Promise<string[]> {
  const barren: string[] = []

  for (const pattern of patterns) {
    // A literal path is a `stat`, not a glob: `tinyglobby` treats a path with
    // no magic characters as a literal anyway, and this keeps the common case
    // off the filesystem walk.
    if (!GLOB_CHARACTERS.test(pattern)) {
      if (!fs.existsSync(pattern)) barren.push(pattern)
      continue
    }

    try {
      const matched = await glob([pattern], { absolute: true })
      if (matched.length === 0) barren.push(pattern)
    } catch {
      // A pattern that cannot even be globbed is the build's problem to
      // report; saying it twice, in a diagnostic, helps nobody.
    }
  }

  return barren
}

// The patterns one configuration reads, resolved the way the build resolves
// them. The watch list, the up-to-date check and the empty-token-set message
// all read a configuration's patterns through here, so they cannot disagree
// about which files it reads.
//
// Against the working directory, because that is where Style Dictionary
// resolves them: `combineJSON` globs each pattern with no `cwd` of its own.
// Resolving against the configuration file's directory instead is how the
// watch list came to name paths the build never reads — a configuration in a
// subdirectory built correctly and watched nothing at all.
//
// An empty pattern is skipped, because Style Dictionary reads nothing from one.
// Resolved, it would be the working directory itself, and the watch list used
// to register exactly that for an empty entry in a `source` array.
export function sourcePatternsOf(configObj: Config): string[] {
  const patterns: string[] = []

  const add = (pattern: unknown) => {
    if (typeof pattern === 'string' && pattern !== '') {
      patterns.push(
        (path.isAbsolute(pattern)
          ? pattern
          : path.resolve(process.cwd(), pattern)
        ).replace(/\\/g, '/'),
      )
    }
  }

  for (const value of [configObj.source, configObj.include]) {
    if (Array.isArray(value)) value.forEach(add)
    else add(value)
  }

  return patterns
}

// Parse token files to watch
//
// The patterns alone. Expanding them into the paths a watcher takes, and
// remembering them for `watchChange` to filter against, is the caller's: the
// second is state of one plugin instance, and this module holds none.
export async function watchPatternsOf(
  {
    log,
    root,
    watch,
  }: {
    log: Log
    root: string
    watch: UnpluginStyleDictionaryOptions['watch']
  },
  resolvedConfigs: ResolvedConfig[],
): Promise<string[]> {
  const filesToWatch = new Set<string>()

  for (const item of resolvedConfigs) {
    if (item.file) {
      filesToWatch.add(item.file.replace(/\\/g, '/'))
    }

    const configObj = await readConfigObject(item, log)

    if (configObj) {
      for (const pattern of sourcePatternsOf(configObj)) {
        filesToWatch.add(pattern)
      }
    }
  }

  // Add manually configured watch files
  if (watch) {
    const extraWatches = Array.isArray(watch) ? watch : [watch]
    for (const pattern of extraWatches) {
      const absolutePattern = path.isAbsolute(pattern)
        ? pattern
        : path.resolve(root, pattern)
      filesToWatch.add(absolutePattern.replace(/\\/g, '/'))
    }
  }

  return Array.from(filesToWatch)
}

// The leading run of a pattern that contains no glob character —
// `/p/tokens` for `/p/tokens/**/*.json`. Registering it alongside the files
// that match today is what makes a token file created tomorrow visible:
// watching only the current matches can never see a path that did not exist
// when the watcher was built.
function staticParentOf(pattern: string): string {
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex((segment) =>
    GLOB_CHARACTERS.test(segment),
  )

  return firstGlob === -1
    ? path.posix.dirname(pattern)
    : segments.slice(0, firstGlob).join('/')
}
