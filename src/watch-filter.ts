import picomatch from 'picomatch'

// Whether `file` matches one of the resolved config/token watch patterns.
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
// `generatedDestinations` and `isWatchedSource` in the factory below.
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
export function matchesWatchedFile(file: string, patterns: string[]): boolean {
  const normalizedFile = file.replace(/\\/g, '/')

  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, '/')

    // A config file reaches this function as its own literal path, which is
    // both the common case and the one shape that is not a glob at all.
    return (
      normalizedPattern === normalizedFile ||
      picomatch.isMatch(normalizedFile, normalizedPattern)
    )
  })
}
