# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`@kanso-labs/unplugin-style-dictionary` compiles Style Dictionary design tokens
ahead of a bundler, and watches and recompiles them while a dev server runs. It
is built on [unplugin](https://unplugin.unjs.io), so one implementation in
`src/index.ts` targets Vite, Rolldown, Rollup and Webpack.

`src/{vite,rolldown,rollup,webpack}.ts` are three lines each — they re-export
the matching `unplugin.<target>` and exist to give every bundler its own
package entry point. **The behaviour lives in `src/index.ts` alone**, so a fix
belongs there and reaches all four targets at once.

[`README.md`](README.md) is the consumer-facing documentation: options, per
bundler usage, examples. Keep it correct when you change the public surface.

## Commands

| Task  | Command           | Notes                                    |
| ----- | ----------------- | ---------------------------------------- |
| Test  | `npm test`        | Vitest, one run, no watch                |
| Lint  | `npm run lint`    | ESLint, including Prettier as a rule     |
| Build | `npm run build`   | `tsc -b`, then Vite library build        |

**There is no `format` script.** Prettier is installed and configured in
`.prettierrc.js`, but it runs only through `eslint-plugin-prettier` inside
`npm run lint` — so `npm run lint -- --fix` is what reformats code (the extra
`--` is what passes the flag to ESLint rather than to npm), and the sibling
repositories' `npm run format` does not exist here.

**Nothing formats or lints Markdown, JSON or YAML.** `eslint.config.js` scopes
itself to `**/*.{ts,js,mjs,cjs}`. Match the surrounding style by hand.

Node comes from `.tool-versions` (24.19.0), which is what CI resolves.

## Conventions

Shared with the other `kanso-labs` repositories:

- **Keys in JSON and YAML are ordered by name.** Files whose order carries
  meaning are exempt: workflows, where step order is execution order;
  changelogs, which are chronological; and `package.json`, where the npm
  ecosystem expects `name` and `version` first.
- **A workflow's filename is the kebab-case of its `name:` field.** Reusable
  workflows, meaning those triggered only by `workflow_call`, take a leading
  underscore.
- **Job names and step names are imperative verb phrases.** Job ids, step ids
  and matrix keys are exempt.
- **Actions are pinned to exact release tags**, never a moving major or
  `@main`. Renovate opens the bump pull requests.

In TypeScript that ordering rule is enforced rather than trusted:
`eslint-plugin-perfectionist` runs at `recommended-natural`, so object keys,
imports and union members are sorted by the linter.

Specific to this repository:

- Every public option is declared and documented in `src/types.ts`. That file
  is the contract the README describes — change them together.
- The build emits ESM and CJS for all five entry points, wired through
  `exports` in `package.json`. Adding a bundler target means a new
  `src/<target>.ts`, a new entry in `vite.config.ts`, and a new `exports` key.

## Testing

`tests/index.test.ts` drives the Vite target against real files in a temporary
directory, rather than mocking Style Dictionary.

Hooks are called with a hand-built context. Vite and Rollup normally supply the
plugin-context `this` — `addWatchFile` and friends — when they invoke a hook, so
the tests bind a minimal stub via `callBuildStart` and `callWatchChange` instead
of starting a dev server. **A new hook needs a matching caller**; calling it
bare leaves `this` undefined and the failure looks like a plugin bug.

## Workflows and checks

`Build`, `Lint` and `Test` each run on `pull_request` only — **none of them runs
on pushes to `main`**. The three are the checks the repository's ruleset
requires, so a merge is gated on them, but `main` itself is never re-verified
after the fact.

All four workflows consume `kanso-labs/github-actions` at an exact release tag,
never a moving major. A change over there reaches this repository only when
Renovate bumps that pin, which is deliberate — see that repository's
`AGENTS.md`.

## Commits and pull requests

Pull requests are squash-merged, so the pull request title becomes the only
commit on `main` and is the single input to `release-please`: `feat` for a
minor, `fix` for a patch, `!` for a breaking change, anything else releases
nothing. `bump-minor-pre-major` is set, so while the version is below 1.0.0 a
breaking change takes the minor.

Write branch commits conventionally anyway — they are what a reviewer reads
while the pull request is open.

## Traps

**Releases cannot currently complete, and the failure is quiet.**
`release-please.yaml` passes `RELEASE_PLEASE_CLIENT_ID` and
`RELEASE_PLEASE_PRIVATE_KEY`, and neither secret exists in this repository. An
unset secret arrives as an empty string, which selects the shared workflow's
`GITHUB_TOKEN` fallback and prints a warning rather than failing. But a pull
request opened with `GITHUB_TOKEN` starts no workflow runs, so the release pull
request never starts `Build`, `Lint` or `Test` — the three checks the ruleset
requires to merge it. The release pull request is therefore proposed and then
unmergeable. Installing the app `home-assistant-applications` already uses and
adding those two secrets is the fix, and needs no change to the workflow.

**The watched-file filter is what stops an infinite rebuild loop.**
`matchesWatchedFile` guards both the Vite `configureServer` watcher and the
universal `watchChange` hook. Without it `watchChange` fires for any changed
file in the host bundler's module graph — including this plugin's own generated
output, since consuming code imports it. Each regenerate is itself a change, so
dropping the filter rebuilds forever. `tests/index.test.ts` pins this directly;
do not "simplify" the guard.

**Vite needs the `configureServer` escape hatch, and that is not redundancy.**
Token sources are plain JSON and JS files sitting outside the module graph, and
Vite does not reliably invoke `watchChange` while serving. `watchChange` alone
covers the targets that run a persistent watcher of their own, such as
`rollup --watch`; the Vite dev server needs both.

**A one-shot build only compiles once, in `buildStart`.** Anything without a
persistent watch mode — `rolldown build` or `tsdown` with no `--watch` — gets no
rebuild-on-change, and that is expected rather than a bug to fix.

**`release_created` is compared against the string `'true'` on purpose.** The
output carries the string `"false"` when release-please runs and decides not to
cut a release, and a bare truthiness test passes on that — publishing every
merge to npm.

**commitlint is installed but never runs.** `@commitlint/cli` 21.2.2,
`@commitlint/config-conventional` and `.commitlintrc.js` are all present, and
`package.json` has `"prepare": "husky"`, but `.husky/` contains only husky's own
`_` directory — there is no `commit-msg` hook and no workflow invoking it. A
malformed type reaches `main` unnoticed and lands in the changelog, so the pull
request title is on the author to get right. `kanso-ui` has the same gap.
