// The `source` and `include` patterns a configuration reads, the watch list
// derived from them, and the paths a watcher is actually handed for it.
//
// Nothing here holds state. What a plugin instance owns — its root, its
// logger, its `watch` option — is handed in on each call.

import type { Config } from 'style-dictionary'

import fs from 'node:fs'
import path from 'node:path'
import { escapePath, glob } from 'tinyglobby'

import type { Log, ResolvedConfig } from './config.js'
import type { UnpluginStyleDictionaryOptions } from './types.js'

import { readConfigObject } from './config.js'
import { errorMessage } from './errors.js'

// A pattern is a glob when any of these appear in it. Deliberately the set
// picomatch and tinyglobby act on, since those two are what match and expand
// here — a path containing one of these characters literally is not
// distinguishable from a pattern, and would not be matchable either.
//
// That is why it is only ever asked of what a consumer wrote. The plugin
// makes a relative pattern absolute by prefixing a directory of its own
// choosing, and that directory's characters are no part of the pattern.
const GLOB_CHARACTERS = /[!*?[\]{}]/

// The patterns a watch list is made of, split by what each one is. The split
// is decided once, from the pattern as the consumer wrote it, and never again
// from the absolute string: that string carries the project's own path, and a
// project in `Dropbox (Personal)` or `app [v2]` would read as a glob.
//
// `literals` are absolute paths, matched by equality and registered as they
// are. `globs` are absolute patterns in picomatch's syntax, in which the part
// the plugin prefixed is escaped.
export interface WatchPatterns {
  globs: string[]
  literals: string[]
}

// What a watcher is handed, and what a changed path is tested against, are
// not the same list, and conflating them is why a glob source was watched by
// nothing at all. Every watcher in play takes filenames rather than
// patterns: Vite's chokidar and rollup's `FileWatcher` are both constructed
// with `disableGlobbing: true`, Vite's `addWatchFile` drops anything that
// fails `fs.existsSync`, and webpack never globs `fileDependencies`. So the
// patterns stay for matching and the paths are expanded for registering.
export async function expandPatterns(
  { globs, literals }: WatchPatterns,
  log: Log,
): Promise<string[]> {
  const paths = new Set<string>(literals)

  for (const pattern of globs) {
    // Watching the directory as well as its current contents. chokidar
    // reports a creation inside a watched directory, which is the only way a
    // token file added later is ever noticed.
    const parent = staticParentOf(pattern)
    if (parent && fs.existsSync(parent)) paths.add(parent)
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
export async function patternsMatchingNothing({
  globs,
  literals,
}: WatchPatterns): Promise<string[]> {
  // A literal path is a `stat`, not a glob, which keeps the common case off
  // the filesystem walk.
  const barren = literals.filter((literal) => !fs.existsSync(literal))

  for (const pattern of globs) {
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
export function sourcePatternsOf(configObj: Config): WatchPatterns {
  const patterns: WatchPatterns = { globs: [], literals: [] }

  const add = (pattern: unknown) => {
    if (typeof pattern === 'string' && pattern !== '') {
      addAnchored(patterns, process.cwd(), pattern)
    }
  }

  for (const value of [configObj.source, configObj.include]) {
    if (Array.isArray(value)) value.forEach(add)
    else add(value)
  }

  return patterns
}

// The `watch` option's entries, resolved the way #369 settled: a relative one
// against `root`, since it is an option of this plugin rather than a path
// inside a configuration. The watch list and the up-to-date check both read
// them through here.
export function watchOptionPatterns(
  root: string,
  watch: UnpluginStyleDictionaryOptions['watch'],
): WatchPatterns {
  const patterns: WatchPatterns = { globs: [], literals: [] }

  for (const pattern of watch ? (Array.isArray(watch) ? watch : [watch]) : []) {
    addAnchored(patterns, root, pattern)
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
): Promise<WatchPatterns> {
  const globs = new Set<string>()
  const literals = new Set<string>()

  const add = (patterns: WatchPatterns) => {
    for (const pattern of patterns.globs) globs.add(pattern)
    for (const literal of patterns.literals) literals.add(literal)
  }

  for (const item of resolvedConfigs) {
    // A path, whatever characters its directories happen to contain.
    if (item.file) literals.add(item.file.replace(/\\/g, '/'))

    const configObj = await readConfigObject(item, log)
    if (configObj) add(sourcePatternsOf(configObj))
  }

  add(watchOptionPatterns(root, watch))

  return { globs: Array.from(globs), literals: Array.from(literals) }
}

// One pattern as a consumer wrote it, made absolute against `base` and filed
// under what it is.
//
// Whether it is a glob is read off what they wrote, before anything is
// prefixed, and of a relative glob only the prefix is escaped. The rest is
// theirs, glob characters included, exactly as `GLOB_CHARACTERS` says. The
// prefix is `base` joined with the pattern's leading static segments,
// resolved together so a `./` or `../` still settles against `base`.
//
// An absolute glob is taken as written. Every character in it is the
// consumer's, and escaping any would be guessing which they meant as syntax.
function addAnchored(into: WatchPatterns, base: string, written: string): void {
  const pattern = written.replace(/\\/g, '/')

  if (!GLOB_CHARACTERS.test(pattern)) {
    into.literals.push(path.resolve(base, pattern).replace(/\\/g, '/'))
    return
  }

  if (path.isAbsolute(pattern)) {
    into.globs.push(pattern)
    return
  }

  const segments = pattern.split('/')
  const firstGlob = segments.findIndex((segment) =>
    GLOB_CHARACTERS.test(segment),
  )
  const prefix = path
    .resolve(base, segments.slice(0, firstGlob).join('/'))
    .replace(/\\/g, '/')

  into.globs.push(
    path.posix.join(escapePath(prefix), segments.slice(firstGlob).join('/')),
  )
}

// The leading run of a pattern that contains no glob character —
// `/p/tokens` for `/p/tokens/**/*.json`. Registering it alongside the files
// that match today is what makes a token file created tomorrow visible:
// watching only the current matches can never see a path that did not exist
// when the watcher was built.
//
// An escaped character is not a glob character, so the prefix `addAnchored`
// escaped never ends the run, and the result is unescaped: it is a path on
// disk, handed to `fs.existsSync` and to the watcher. Before the prefix was
// escaped, a project in `app [v2]` cut the run at its own directory, and the
// directory holding every project beside it was registered instead.
function staticParentOf(pattern: string): string {
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex((segment) =>
    GLOB_CHARACTERS.test(segment.replace(/\\./g, '')),
  )

  const parent =
    firstGlob === -1
      ? path.posix.dirname(pattern)
      : segments.slice(0, firstGlob).join('/')

  return parent.replace(/\\(.)/g, '$1')
}
