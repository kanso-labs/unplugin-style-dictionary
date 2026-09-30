import path from 'node:path'
import picomatch from 'picomatch'

import type { WatchPatterns } from './patterns.js'

// Whether a forward-slashed path is one a watch list names.
export type WatchMatcher = (normalizedFile: string) => boolean

// One watch list compiled into a matcher, once, where the list is derived.
// picomatch compiles a pattern on every `isMatch`, with no cache, so asking
// per event compiled every pattern again for every file a watcher reported —
// under a dev server, each unrelated save went through the filter twice. The
// matcher is the factory's to hold, beside the list it came from: one module
// serves every plugin instance, so a cache here would be state in a module
// that holds none.
//
// A literal is a path, so it is compared as one. A config file reaches here
// that way, and so does a token file named without a glob, and neither may be
// read as a pattern: the project's own directory can hold characters a glob
// treats as syntax. The globs are compiled exactly as given — see
// `matchesWatchedFile` below — and an absolute path a consumer wrote with a
// glob character in it is filed as a glob and still names itself.
export function compileWatchPatterns({
  globs,
  literals,
}: WatchPatterns): WatchMatcher {
  const named = new Set([...globs, ...literals])
  const matchesGlob = globs.length > 0 ? picomatch(globs) : () => false

  return (normalizedFile) =>
    named.has(normalizedFile) || matchesGlob(normalizedFile)
}

// Whether a changed file is a token or config source rather than something
// this plugin just wrote. Both watch entry points ask through here, so
// neither can react to its own output.
//
// `generatedDestinations` is the plugin instance's own record of what it
// wrote, so it is handed in rather than held: one module serves every
// instance in the process, and each one's output is its own.
//
// It takes the list compiled rather than the list: see `compileWatchPatterns`.
export function isWatchedSource(
  file: string,
  matches: WatchMatcher,
  generatedDestinations: ReadonlySet<string>,
): boolean {
  const normalizedFile = file.replace(/\\/g, '/')

  return !generatedDestinations.has(normalizedFile) && matches(normalizedFile)
}

// Whether `file` matches one of the resolved config/token watch patterns,
// compiled for this one question. Every event goes through
// `compileWatchPatterns` instead; this stays for a one-off answer.
// Shared by the Vite-specific `configureServer` watcher and the universal
// `watchChange` hook — both need it, and both must skip files that don't
// match: without this filter, `watchChange` reacts to *any* changed
// module-graph file, including this plugin's own generated output (since
// consuming code imports it). Every regenerate is itself a "change", which
// without filtering re-triggers a rebuild forever.
//
// Matching a pattern is only half of that, and this function is only the half
// it can answer. A `buildPath` inside a `source` directory is a supported
// layout, and under any correct matcher its output matches the very glob that
// produced it — so the caller also subtracts what the last build wrote. See
// `isWatchedSource` above, and `generatedDestinations` in the factory.
//
// The patterns are Style Dictionary's own `source` and `include` globs, so the
// filter has to admit exactly what the build reads — which is why the matching
// is a real globber's rather than hand-rolled. The version this replaces was
// wrong in both directions at once: it stripped `/**` out of a pattern and
// prefix-matched the remainder, so `tokens/**/*.json` matched nothing sitting
// directly in `tokens/` and `tokens/**` matched a `tokens-backup/` sibling,
// while its regex branch mapped every `*` to `.*` — crossing `/` — and tested
// it unanchored, so generated output under a watched directory matched its own
// source glob and rebuilt forever.
//
// picomatch rather than `path.matchesGlob`, which would need no dependency at
// all: that function is documented experimental, and on Node 20 — the floor
// `engines` declares — it prints `ExperimentalWarning: glob is an experimental
// feature and might change at any time` into the consumer's build output. The
// dependency is free in practice, since `unplugin` depends on the same
// picomatch and is already installed wherever this plugin is. Its `dot: false`
// default is deliberate: it is what glob, and so Style Dictionary, reads
// sources with, so a dotfile is invisible to the filter and to the build alike.
//
// **The patterns are used exactly as given.** A backslash in one is an escape:
// the part of a pattern the plugin prefixed is escaped, and every producer
// already writes separators as `/`. Rewriting backslashes to slashes here
// turned each escape into a separator, so a project in `Dropbox (Personal)`
// matched none of its own token files.
export function matchesWatchedFile(file: string, patterns: string[]): boolean {
  const normalizedFile = file.replace(/\\/g, '/')

  return patterns.some(
    (pattern) =>
      // An absolute path a consumer wrote with a glob character in it is filed
      // as a glob, and still names itself.
      pattern === normalizedFile || picomatch.isMatch(normalizedFile, pattern),
  )
}

// The spelling the watch patterns use for `file`, which a host watching a
// registered realpath reports by where a link leads rather than by the link.
// `linkedPaths` maps each registered path that runs through a link from its
// realpath back to the spelling it was registered under, and is the plugin
// instance's, so it is handed in rather than held.
//
// The lookup walks up from `file` rather than asking about it alone, because
// a pattern's static parent directory is registered so that a token file
// created in it later is noticed — and that file arrives spelled under the
// directory's realpath, which only the directory is a key for.
export function registeredSpellingOf(
  file: string,
  linkedPaths: ReadonlyMap<string, string>,
): string {
  if (linkedPaths.size === 0) return file

  const normalizedFile = file.replace(/\\/g, '/')

  for (let real = normalizedFile; ; real = path.posix.dirname(real)) {
    const registered = linkedPaths.get(real)
    if (registered !== undefined) {
      return registered + normalizedFile.slice(real.length)
    }

    if (path.posix.dirname(real) === real) return file
  }
}
