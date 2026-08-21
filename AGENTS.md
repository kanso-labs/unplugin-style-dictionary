# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`@kanso-labs/unplugin-style-dictionary` compiles Style Dictionary design tokens
ahead of a bundler, and watches and recompiles them while a dev server runs. It
is built on [unplugin](https://unplugin.unjs.io), so one implementation in
`src/index.ts` targets Vite, Rolldown, Rollup and Webpack.

`src/{vite,rolldown,rollup,webpack}.ts` are three lines each — they re-export
the matching `unplugin.<target>` and exist to give every bundler its own package
entry point. **The behaviour lives in `src/index.ts` alone**, so a fix belongs
there and reaches all four targets at once.

[`README.md`](README.md) is the consumer-facing documentation: options, per
bundler usage, examples. Keep it correct when you change the public surface.

## Commands

| Task   | Command          | Notes                                               |
| ------ | ---------------- | --------------------------------------------------- |
| Test   | `npm test`       | Vitest, one run, no watch                           |
| Lint   | `npm run lint`   | oxlint, then ESLint, then oxfmt formatting check    |
| Format | `npm run format` | oxfmt; `npm run format:check` is the check          |
| Build  | `npm run build`  | Type-checks (`tsc -b`) then builds ESM into `dist/` |

**oxfmt formats this repository, not Prettier.** The formatter runs as its own
`npm run format`, and `npm run lint` ends in `oxfmt --check` so a badly
formatted file fails `Lint` rather than being quietly rewritten.
`eslint-plugin-prettier` is gone, so `npm run lint -- --fix` no longer reformats
anything — reach for `npm run format`.

**oxfmt covers Markdown, JSON and YAML as well as TypeScript**, which is new:
nothing formatted those before. `CHANGELOG.md` is the one exemption, via
`ignorePatterns` in `.oxfmtrc.json` — release-please rewrites it on every
release in a style oxfmt disagrees with, so formatting it only holds until the
next release pull request, at which point `Lint` fails on a branch nobody
hand-edits.

**oxlint runs type-aware, and its ruleset is stricter than the code was written
against.** `.oxlintrc.json` runs the `correctness`, `suspicious` and `perf`
categories with `typeAware` turned on, over the typescript, unicorn, oxc,
import, promise and vitest plugins. One rule is switched off outright:
`no-await-in-loop`. Every loop it flagged awaits on purpose — `runBuilds`
compiles each Style Dictionary config in turn, and letting those overlap would
have two builds writing the same destinations at once. The rule's advice to
collect the promises and `Promise.all` them is a bug here, not an optimisation.

<!-- shared:node-install -->

**Install with the Node version in `.tool-versions` (24.19.0).** CI resolves it
from that file, and an older npm silently drops the platform entries the
lockfile carries for Linux builds — a rewrite with no visible symptom until a
Linux runner installs the wrong native binary. If `node --version` disagrees,
prefix the command: `mise exec node@24.19.0 -- npm install`.
<!-- /shared:node-install -->

## Conventions

Shared with the other `kanso-labs` repositories:

<!-- shared:conventions -->

- **Keys in JSON and YAML are ordered by name.** Files whose order carries
  meaning are exempt: workflows, where step order is execution order;
  changelogs, which are chronological; and `package.json`, where the npm
  ecosystem expects `name` and `version` first.
- **A workflow's filename is the kebab-case of its `name:` field.** Reusable
  workflows, meaning those triggered only by `workflow_call`, take a leading
  underscore.
- **Job names and step names are imperative verb phrases.** Job ids, step ids,
  and matrix keys are exempt.
- **Actions are pinned to exact release tags**, `actions/checkout@v7.0.1`, never
  a moving major or `@main`. Renovate opens the bump pull requests.
- **Dependency versions are pinned exactly.** Every `dependencies`,
  `devDependencies`, and `optionalDependencies` entry is a bare version,
  `1.2.3`, never `^1.2.3`, `~1.2.3`, `>=1.2.3`, `*`, `1.x`, or an `||` union.
  Renovate opens those bumps too. `peerDependencies` are the deliberate
  exception: they state what the consumer's own installed copy must satisfy, so
  ranges are correct there and stay.
- **`.tool-versions` pins a fully-specified version on every line**,
  `nodejs 24.19.0`, never `nodejs 24` or `nodejs lts`.

<!-- /shared:conventions -->

In TypeScript that ordering rule is enforced rather than trusted:
`eslint-plugin-perfectionist` runs at `recommended-natural`, so object keys,
imports and union members are sorted by the linter.

Specific to this repository:

- Every public option is declared and documented in `src/types.ts`. That file is
  the contract the README describes — change them together.
- The build emits ESM for all five entry points, wired through `exports` in
  `package.json`. Adding a bundler target means a new `src/<target>.ts`, a new
  entry in `tsdown.config.ts`, and a new `exports` key.

## Testing

`tests/index.test.ts` drives the Vite target against real files in a temporary
directory, rather than mocking Style Dictionary.

Hooks are called with a hand-built context. Vite and Rollup normally supply the
plugin-context `this` — `addWatchFile` and friends — when they invoke a hook, so
the tests bind a minimal stub via `callBuildStart` and `callWatchChange` instead
of starting a dev server. **A new hook needs a matching caller**; calling it
bare leaves `this` undefined and the failure looks like a plugin bug.

## Workflows and checks

`Build`, `Lint` and `Test` run on `pull_request` and on pushes to `main`. The
three are the checks the repository's ruleset requires, so a merge is gated on
them, and the push trigger is what re-verifies `main` afterwards rather than
leaving it on trust.

<!-- shared:pull-request-unscoped -->

The `pull_request` trigger is deliberately unscoped. Adding `branches: [main]`
would match the sibling repositories, but a pull request opened against any
other base would then post none of the checks the ruleset requires, which reads
as a hang rather than a failure because nothing will ever report.
<!-- /shared:pull-request-unscoped -->

<!-- shared:job-name-check -->

**A job name becomes a check name.** Renaming a job edits the merge gate rather
than the label on it, so keep the job name and the ruleset in sync in one
change.
<!-- /shared:job-name-check -->

Ruleset `19123565` ("Default") requires `Build`, `Lint` and `Test` by exact
string.

`Lint` runs actionlint as a step rather than as a job of its own, and that is
the reason why: a new job is a new check name, nothing requires it, and it would
be free to fail without stopping anything.

Everything shared comes from `kanso-labs/github-actions` at an exact release
tag, never a moving major — `actions/setup-node`, `actions/lint-workflows`,
`_release-please.yaml`, `_publish-npm.yaml` and `_renovate-command.yaml`. A
change over there reaches this repository only when Renovate bumps the pin,
which is deliberate — see that repository's `AGENTS.md`.

`renovate-command.yaml` is what makes `@renovate rebase` work on a dependency
pull request here. Only the copy on `main` ever runs: `issue_comment` is a
repository-level event, so a change to that file cannot be tested from a branch.

## Commits and pull requests

Pull requests are squash-merged, so the pull request title becomes the only
commit on `main` and is the single input to `release-please`: `feat` for a
minor, `fix` or `deps` for a patch, `!` for a breaking change, anything else
releases nothing. `bump-minor-pre-major` is set, so while the version is below
1.0.0 a breaking change takes the minor.

<!-- shared:branch-commits -->

Write branch commits conventionally anyway. They are what a reviewer reads while
the pull request is open, even though only the title survives the merge.
<!-- /shared:branch-commits -->

Renovate's own commits are typed `deps:`, and that type is what makes them
release. release-please computes a patch bump for any commit that is not a
`feat` or a breaking change, but it only proposes a release when the notes it
generated are non-empty — a run whose every commit falls in a hidden changelog
section is skipped as "No user facing commits found". Renovate's default,
`chore(deps):`, lands in exactly such a section, so an upgrade never cut a
release of its own; it shipped only when a feature happened to land beside it,
and a run of nothing but upgrades published nothing at all.
`.github/renovate.json` therefore sets `semanticCommits: enabled`,
`semanticCommitType: deps` and `semanticCommitScope: null`, and
`release-please-config.json` spells out `changelog-sections` with `deps` visible
under a `Dependencies` heading. The two move together: that list replaces
release-please's defaults wholesale, so a type missing from it is invisible
rather than merely unstyled, and `deps` with no matching section would put the
upgrades back where they started.

**`semanticCommitType` sits in a `packageRule`, and that is the whole fix.** It
was a top-level key at first and did nothing at all. `config:recommended`
extends `:semanticPrefixFixDepsChoreOthers`, which sets the type through
`packageRules` — `matchPackageNames: ["*"]` to `chore`, plus a narrower
`dependencies` to `fix` — and `packageRules` beat top-level config. So Renovate
went on writing `chore:` while the setting sat there looking correct, and only
production dependencies released at all.

`deps` is not one of the Conventional Commits types, so `.commitlintrc.js`
extends the `type-enum` rule from `@commitlint/config-conventional` to admit it
alongside the standard eleven — which nothing enforces today, since commitlint
never runs here, but is what `npx commitlint` accepts and what the `commit-msg`
hook would accept the day one exists. A plain `chore:` still publishes nothing,
which is the point: housekeeping should not cut a release.

## Traps

**Releases used to tag but never reach npm, and what fixed it was not in this
repository.** `Publish to npm` failed with `npm error code E404` on the `PUT` to
`https://registry.npmjs.org/@kanso-labs%2funplugin-style-dictionary`, leaving
the 0.2.2 tag and GitHub release standing while npm still served 0.2.1. The job
was authenticating with nothing: `id-token: write` was granted and Node
24.19.0's npm was new enough for trusted publishing, but the run log showed no
OIDC exchange even attempted, so npm made the `PUT` unauthenticated — and npm
answers an unauthorized write with 404 rather than 403 so as not to leak whether
a package exists. The missing half was on the registry: no trusted publisher was
configured for this package on npmjs.com.

Configuring it against this repository and `release-please.yaml` was the whole
fix, and it needed no change to any workflow. It holds: 0.2.2 and 0.2.3 are on
npm under `_npmUser` `GitHub Actions` and carry provenance attestations, where
0.2.0 and 0.2.1 were pushed by hand under `kanso-labs-admin` and carry none.
Keep the shape of this in mind rather than the symptom — a publish that
authenticates with nothing looks, from the run log, exactly like a publish whose
credentials were rejected.

**`release-please.yaml` used to describe a failure that no longer happens.** Its
comments said the two secrets did not exist, that the shared workflow therefore
fell back to `GITHUB_TOKEN`, and that `permissions:` was wide to suit. All three
were superseded, as the 0.2.2 run shows: `Mint an application token` succeeded
and `Warn that no application token was supplied` was skipped. The comments and
the wide grant are both gone now, and `GITHUB_TOKEN` is back on
`contents: read`.

That superseded failure is also why the npm one went unseen for so long.
`Publish to npm` is gated on `release_created`, no release pull request had ever
been mergeable, and so the job had never once run before 0.2.2.

**Moving the publish into the shared workflow does not change what npm
validates.** `Publish to npm` calls `_publish-npm.yaml`, but npm's trusted
publishing checks the _entry point_ workflow rather than the reusable one that
runs `npm publish` — so the name registered on npmjs.com is
`release-please.yaml`, exactly as it was before the move. `id-token: write` has
to be granted on both the calling job and the called workflow, and it is.
Renaming this file, or moving the publish job into a different one, breaks the
publish until the trusted publisher is re-registered against the new name.

**Only the npm half of the publish is registered anywhere.** The shared workflow
also pushes to GitHub Packages, and that half has no trusted publisher, no OIDC
exchange and no attestation — it authenticates with `GITHUB_TOKEN` and
`packages: write`, both of which the run already has. So nothing needs
registering for it, and nothing about it is affected by what this file is
called.

This trap used to end by warning that GitHub Packages creates a new package
private, and that it would need flipping under the organization's **Packages**
tab. It did not: 0.2.5 created the package and it came out `visibility=public`
with no manual step. This is a public repository with `publishConfig.access` set
to `public`, so this is not a general rule, just one fewer thing to do here.
Visibility is still a package-level setting nothing in the run reports, so it is
worth a glance the first time a package appears on a registry.

**`fixedExtension: false` in `tsdown.config.ts` cannot be removed.** tsdown
derives `fixedExtension` from `platform`, and `platform` defaults to `node` —
which is right for a build-time plugin, but flips the default to emitting ESM as
`.mjs`. Every `import` condition in `package.json`, plus `module` and `types`,
names `.js`. Delete the line and the build still succeeds, the tests still pass,
and the published package resolves to nothing. A project that reaches the same
extensions through `platform: 'neutral'` needs no such line, so copying another
repository's config rather than its outcome reintroduces this.

**The exports map says `default`, not `import`, and the difference is whether
CommonJS works at all.** With only an `import` condition a `require()` of this
package fails outright with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Under `default`,
Node resolves the same ESM file and serves the caller through `require(esm)`.
That one word is the whole of this package's CommonJS support, so renaming it to
`import` — which reads like a tidy-up next to a `type: module` package — removes
support for every CommonJS consumer.

**A `require()` of a target entry returns the namespace, so callers need
`.default`.** Node hands a `require(esm)` caller the module namespace object,
not the default export. That was briefly untrue: while the package shipped a
CommonJS build, tsdown's `cjsDefault` rewrote the four single-default target
entries to `module.exports = fn`, and `require()` gave the function directly.
Dropping that build put the `.default` hop back. The README documents the
current form; keep the two together.

**The watched-file filter is what stops an infinite rebuild loop.**
`matchesWatchedFile` guards both the Vite `configureServer` watcher and the
universal `watchChange` hook. Without it `watchChange` fires for any changed
file in the host bundler's module graph — including this plugin's own generated
output, since consuming code imports it. Each regenerate is itself a change, so
dropping the filter rebuilds forever. `tests/index.test.ts` pins this directly;
do not "simplify" the guard.

**Generated files go through a temporary file and a `rename` on purpose.** Style
Dictionary writes each file straight to its destination, which truncates it
first, so anything importing a generated file mid-rebuild — a consuming test
run, a dev-server request — reads a partial file and fails to parse it.
`runBuilds` therefore hands the instance an `atomicVolume`: `node:fs` with both
write entry points swapped for versions that write a sibling temporary file and
rename it over the destination, `rename` being atomic within a filesystem. It is
assigned onto the instance rather than passed as Style Dictionary's `volume`
constructor option, because that option also marks the volume as a custom
filesystem shim and turns path resolution off for every read.
`tests/index.test.ts` pins this with a concurrent reader; a single clean build
proves nothing, since the window is only tens of milliseconds wide.

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

<!-- shared:commitlint -->

**commitlint is installed but never runs.** `@commitlint/cli`,
`@commitlint/config-conventional` and `.commitlintrc.json` are all present, and
`.husky/` carries a `pre-commit` hook — but that hook runs lint-staged, not
commitlint. There is no `commit-msg` hook and no workflow invoking one, so a
malformed type reaches `main` unnoticed and lands in the changelog, and the pull
request title is on the author to get right.
<!-- /shared:commitlint -->

The hook directory existing makes this easier to misread as solved than it was
when the directory held nothing but husky's own `_`.
