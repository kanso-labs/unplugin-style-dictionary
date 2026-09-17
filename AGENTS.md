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

| Task   | Command                 | Notes                                                                               |
| ------ | ----------------------- | ----------------------------------------------------------------------------------- |
| Test   | `npm test`              | Vitest, one run, no watch                                                           |
| Lint   | `npm run lint`          | oxlint, then ESLint, then oxfmt formatting check                                    |
| Format | `npm run format`        | oxfmt; `npm run format:check` is the check                                          |
| Build  | `npm run build`         | Type-checks (`tsc -b`) then builds ESM into `dist/`                                 |
| Verify | `npm run package:check` | publint, then `scripts/check-package.mjs`; reads `dist/`, so it needs a build first |

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

**Install with the Node version in `.tool-versions` (24.19.0).** CI resolves it
from that file, and an older npm silently drops the platform entries the
lockfile carries for Linux builds — a rewrite with no visible symptom until a
Linux runner installs the wrong native binary. If `node --version` disagrees,
prefix the command: `mise exec node@24.19.0 -- npm install`.

## Conventions

Shared with the other `kanso-labs` repositories:

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

**The suite prints nothing to the console, and that takes two different
measures.** A plugin instance in a test is chatty by default, so what a test
does not silence reaches the CI log — where a reader then has to tell the lines
the suite asked for apart from ones it did not.

_Progress lines go through an option, not a spy._ `Compiling design tokens...`
and `Compiled successfully!` are `console.log`, and the plugin already has a
switch for them: pass `logLevel: 'warn'` when building a plugin for a test that
does not assert on them. `'warn'` rather than `'silent'` on purpose — it drops
the plugin's own lines and leaves what Style Dictionary reports exactly as it
was, where `'silent'` also sets Style Dictionary's verbosity and can change what
a test is asserting on.

_Failure reports go through a spy, and the spy asserts._ A failed compile is
reported at every level, `silent` included, because a build the host stops for
has to say why. So a test that provokes one spies `console.error` for the
duration, **asserts the message is there**, and restores in a `finally`.
Capturing without checking would remove the only evidence it was said — reword
the report and ten tests fail today.

**`console.error` is only where the message lands when no host claimed it.** The
plugin hands its lines to the bundler now, so a spy sees them only on the
unit-test path, where `callBuildStart` binds a context carrying `addWatchFile`
and nothing else. Everywhere a real host is driven, the assertion goes to that
host's channel instead: a recording `customLogger` under Vite, `onwarn` under
rollup, `onLog` under rolldown — `onwarn` is deprecated there and the type-aware
lint says so — and `stats.toJson().warnings` under webpack.

Leave the unit-test stub channel-less. Adding `warn` to it would route sixteen
existing `console.error` assertions somewhere they are not looking, and the
fallback is a real path worth keeping covered.

_`console.error` is not the whole surface._ Style Dictionary warns on its own
account — an unrecognised config extension, for one — and that goes to
`console.warn`, which an error spy never sees.

**Sweep for both streams, and do it with the right reporter.** None of this
shows locally by default: the default reporter collapses to a summary, and only
an expanded one prints intercepted console output. Checking only `stderr` is
what let the `stdout` half of this survive a first pass.

```bash
npx vitest run --reporter=verbose 2>&1 | grep -E '^std(out|err) \|'
```

That should print nothing.

## Workflows and checks

`Build`, `Lint` and `Test` run on `pull_request` and on pushes to `main`. The
three are the checks the repository's ruleset requires, so a merge is gated on
them, and the push trigger is what re-verifies `main` afterwards rather than
leaving it on trust.

The `pull_request` trigger is deliberately unscoped. Adding `branches: [main]`
would match the sibling repositories, but a pull request opened against any
other base would then post none of the checks the ruleset requires, which reads
as a hang rather than a failure because nothing will ever report.

**A job name becomes a check name.** Renaming a job edits the merge gate rather
than the label on it, so keep the job name and the ruleset in sync in one
change.

Ruleset `19123565` ("Default") requires `Build`, `Lint` and `Test` by exact
string.

`Lint` runs actionlint as a step rather than as a job of its own, and that is
the reason why: a new job is a new check name, nothing requires it, and it would
be free to fail without stopping anything.

`Build` ends in `npm run package:check` for that same reason. It reads `dist/`,
so it has to come after the build, and a job of its own would be a check name
the ruleset does not require.

**That command is two tools, and the split is what each half can see.** publint
reads `package.json` and the packed file list, so it catches an exports target
aimed at a file the tarball does not carry — which is exactly what losing
`fixedExtension: false` produces. `scripts/check-package.mjs` asks Node to
resolve and then evaluate all five entries, which is the only way to reach the
failures publint calls "All good!": `default` rewritten to `import`, a target
entry that stops handing back a callable `.default`, and a subpath deleted from
the map outright, since publint has no opinion on which subpaths ought to exist.
Neither half is redundant; run the script through the npm script so the command
that gates a branch is the command a contributor runs.

`tests/index.test.ts` pins the same exports map from the source tree, so `Test`
fails on a rewritten condition too, without waiting for a build.

`scripts/check-package.mjs` is the repository's first `.mjs` file, and
`.lintstagedrc.json` matches `*.{mjs,ts}` so the pre-commit hook covers it.
`npm run lint` always did — `oxlint .` and `eslint .` take the whole tree — so
the gap was only ever in the hook, which is the quiet kind.

**`Test` sends its coverage report to two places.**
`actions/upload-code-coverage` reports it under the `code-coverage/vitest`
label, and `codecov/codecov-action` uploads the same Cobertura file to Codecov,
which is what keeps the history the trend lines are drawn from. Both read the
report the first leg wrote, so neither re-measures.

Neither adds a way for `Test` to fail. `fail_ci_if_error` is left at its default
of `false`, and `.github/codecov.yml` marks both of Codecov's statuses
informational — its default project status fails a pull request that lowers
coverage against its base by any amount, which the run-to-run branch swing the
thresholds in `vite.config.ts` are sized for would trip on its own. The floor
there stays the one thing a drop has to clear. That file is `.yml` rather than
the `.yaml` everything else here uses because Codecov recognises `codecov.yml`
and `.codecov.yml` alone.

**A third report goes up beside them, and it is not coverage.** A second
`codecov/codecov-action` step, this one with `report_type: test_results`,
uploads the JUnit XML `vite.config.ts` now writes, which Codecov reads for which
tests failed and which are flaky rather than for a percentage. It is the same
action as the coverage step on purpose: `codecov/test-results-action`, which
Codecov's own docs still point at, prints a deprecation warning naming this one
as its replacement. It carries `if: ${{ !cancelled() }}`, which makes it the one
step in the job that runs when the suite is red — the only time it has anything
to say. Both legs write that file and the last write wins, so a failure on the
floor reaches Codecov instead of the first leg's passes.

Both Codecov uploads want `CODECOV_TOKEN` in the repository's secrets. Without
it they fall back to a tokenless upload, which this repository being public
makes possible but rate-limited, so a report lands intermittently rather than
not at all — which reads as a flaky uploader rather than as a missing secret.

**`Build` also uploads the bundle to Codecov**, through `@codecov/rollup-plugin`
in `tsdown.config.ts`. Codecov's rollup plugin rather than its Vite one: tsdown
is what builds the published package, `vite.config.ts` here configures Vitest
and nothing else, and rolldown's plugin API is rollup's.

`CODECOV_TOKEN` is what switches it on, and `enableBundleAnalysis` reads it
directly. The token is an organisation secret, so it is undefined outside CI and
a local `npm run build` neither writes the stats file nor uploads anything —
which is also what a fork's pull request gets, rather than a failure for want of
a secret it was never going to be given.

**A failed upload does not fail the build**, which is worth knowing before
trusting the absence of an error. An invalid token spends three retries and some
seconds, logs `Failed to get pre-signed URL`, and lets `Run build` pass — so a
bundle that stopped being reported looks exactly like one that is fine. Check
the job log rather than the check mark.

Everything shared comes from `kanso-labs/github-actions` at an exact release
tag, never a moving major — `actions/setup-node`, `actions/lint-workflows`,
`_release-please.yaml`, `_publish-npm.yaml` and `_renovate-command.yaml`. A
change over there reaches this repository only when Renovate bumps the pin,
which is deliberate — see that repository's `AGENTS.md`.

`renovate-command.yaml` is what makes `@renovate rebase` work on a dependency
pull request here. Only the copy on `main` ever runs: `issue_comment` is a
repository-level event, so a change to that file cannot be tested from a branch.

## Commits and pull requests

Pull requests are squash-merged, with the pull request title as the commit
subject and an empty body. That title becomes the only commit on `main`, and
branch commit messages are discarded by the squash and never reach history.

That title is therefore the single input to `release-please`: `feat` for a
minor, `fix` or `deps` for a patch, `!` for a breaking change, anything else
releases nothing. `bump-minor-pre-major` is set, so while the version is below
1.0.0 a breaking change takes the minor.

Write branch commits conventionally anyway. They are what a reviewer reads while
the pull request is open, even though only the title survives the merge.

**Renovate commits are typed `deps:`, and that is what makes them release.**
release-please computes a patch bump for any commit that is not a `feat` or a
breaking change, but it only opens a release pull request when the notes it
generates are non-empty — a run whose every commit falls in a hidden changelog
section is skipped as "No user facing commits found". Renovate's default,
`chore(deps):`, lands in exactly such a section, so an upgrade never cut a
release of its own: it shipped only when a feature happened to land beside it,
and a run of nothing but upgrades published nothing at all.

`.github/renovate.json` therefore sets `semanticCommits: enabled` and
`semanticCommitScope: null` at the top level, and `semanticCommitType: deps` in
a `packageRule` rather than beside them. `release-please-config.json` spells out
`changelog-sections` with `deps` visible under a `Dependencies` heading. The two
move together: that list replaces release-please's defaults wholesale, so a type
missing from it is invisible rather than merely unstyled, and `deps` with no
matching section would put the upgrades back where they started.

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

## Working the improvement plan

The
[Unplugin Style Dictionary project](https://github.com/orgs/kanso-labs/projects/3)
holds the plan that came out of the September 2026 evaluation of this
repository: one issue per pull request, from #184 on, and an issue per spike — a
question one review raised and no second review confirmed, answered by an
experiment before anything is built. Every item carries a Phase, a Kind, an
Area, a Size and a Status, and every issue carries the `v1.0.0` milestone, a
type, a pair of labels, a priority and an effort besides; the Roadmap view is
the board by phase, and each issue names what it depends on. The evaluation the
items were cut from, with every finding and its verdict, is linked from the
project's README.

Items are worked in phase order, and the project is kept current as they are:

- Starting an item sets its Status to In Progress. Its pull request closes it
  with `Closes #N`, and the project's own workflow moves it to Done when that
  pull request merges — nothing else needs to move it.
- Each item branches from `main`, unless its "Depends on" names an issue whose
  pull request has not merged yet, and its pull request title is the issue
  title, which is already the Conventional Commit the changelog wants.
- A spike ends in a written answer. If the answer is yes, the pull request that
  follows carries the conventional type the issue names; if no, the issue is
  closed with the experiment and its result in the closing comment, and that
  reason is recorded in this file where the plan assumed otherwise.

Phases 0 and 1 run in parallel — they touch different parts of `src/index.ts`
and meet only at the destination-set computation. Phase 2 precedes 3, since
threading a resolved config object through to Style Dictionary is only safe once
the resolution base is settled. Phases 5 to 8 come after the fixes, so the
documentation is rewritten once against measured behaviour rather than twice.
Quick wins are one-line changes with no place in that order; they land in any
week. Within a phase, items are independent unless an issue says otherwise, so
they can run in parallel worktrees.

### Every item carries ten fields, and none of them is optional

They come from three different places, which is the whole difficulty: five are
the project's own, three are set on the issue (a pull request carries two of
them, the labels and the milestone), and two are GitHub's native issue fields,
which live in the issue's sidebar and nowhere else. Nothing joins them up, so
each is set in its own place.

| Field     | Set on         | Values                                                     |
| --------- | -------------- | ---------------------------------------------------------- |
| Status    | Project item   | Todo, In Progress, Done                                    |
| Phase     | Project item   | `0 · Watching` through `8 · Hygiene`, and `Quick wins`     |
| Kind      | Project item   | Fix, Feature, Perf, Test, Docs, Tooling, Spike             |
| Area      | Project item   | Watching, Compile, Config, Targets, Options, Packaging, CI |
| Size      | Project item   | S, M, L                                                    |
| Milestone | Issue, PR      | `v1.0.0`                                                   |
| Type      | Issue          | Feature, Bug, Task                                         |
| Labels    | Issue, PR      | one `kind:`, one `area:`                                   |
| Priority  | Issue (native) | Urgent, High, Medium, Low                                  |
| Effort    | Issue (native) | High, Medium, Low                                          |

**Priority and Effort are native issue fields, not project columns.** They are
the set GitHub gives every repository, alongside Start date and Target date, and
they appear in the issue's own sidebar. A native issue field cannot be shown as
a project column and a project field cannot be shown in the sidebar, so there is
no syncing between them and no point adding a project field that duplicates one.
They are also issues-only: passing a pull request's node id to
`setIssueFieldValue` fails with _Could not resolve to Issue node_.

**Four of the ten are derived rather than judged**, so read them off the field
they follow rather than forming a second opinion:

- **Priority follows Phase.** Phases 0 and 1 are Urgent, 2 through 4 are High, 5
  through 7 are Medium, and 8 is Low. Quick wins are Medium: cheap enough to
  land in any week, ahead of nothing. Items are already worked in phase order,
  so a priority disagreeing with the phase would describe an order nobody
  follows. What it buys is a sort that survives being grouped by something other
  than Phase, in a place the board is not.
- **Effort follows Size** — `L` is High, `M` is Medium, `S` is Low. The two ask
  the same question in different vocabularies, and only Size is ever argued. S
  is under half a day, M one to two days, L more.
- **Type follows Kind.** Feature and Perf are a Feature, Fix is a Bug, and Test,
  Docs, Tooling and Spike are a Task.
- **The two labels mirror Kind and Area**, one of each, lower-cased — `kind:fix`
  for Kind `Fix`, `area:watching` for Area `Watching`. A project field is only
  legible inside the project, and the labels are what carry the same two facts
  out to the issue list, to search, and into a notification mail, so
  `label:area:targets` answers from outside the board what the Area field
  answers within it. They are also why `kind:` and `area:` are the only label
  prefixes the plan owns: a label outside those two is nobody's mirror, and is
  left alone by anything editing them in bulk.

Phase, Kind, Area and Size are the judgements, and the issue is where they are
argued rather than the board. Kind follows the title's type where one is
obvious: `fix` is a Fix, `feat` a Feature, `perf` a Perf, `test` a Test, `docs`
Docs, and `ci`, `build` and `chore` are Tooling. Area is the part of the plugin
the work touches — a test item's Area is the subject it tests, a docs item's the
subject it documents.

**Start date and Target date are left empty on purpose.** GitHub offers them on
every issue, but the plan schedules nothing by date — it is ordered by Phase and
worked in that order. Filling them would mean inventing dates that nothing
checks and nothing honours.

**A pull request takes the labels and the milestone, and is not a project
item.** The board is the plan, and the plan is made of issues; a board holding
every merged pull request would bury the items it exists to order under history.
What connects the two is already there — `Linked pull requests` is a column on
the board, so the pull request that closes an item shows against it without
being an item itself. The labels and the milestone are what make a pull request
findable from outside the board, which is all it needed. It takes no type: issue
types are an Issue-only construct — `PullRequest` exposes no such field in
GraphQL, and `is:pr type:Task` matches nothing.

Where its two labels come from depends on whether an issue stands behind it:

- **A pull request that closes a plan issue inherits that issue's Kind and
  Area**, so it carries the same two labels. It is the work the issue describes,
  and giving it a second opinion would only split one thing across two answers.
- **A pull request with nothing behind it reads its Kind off its Conventional
  Commit type** — `feat` is a Feature, `fix` a Fix, `perf` a Perf, `docs` Docs,
  `test` a Test, and `chore`, `ci` and `build` are Tooling. Its Area is the part
  of the plugin its scope names: `fix(watch)` is `area:watching`, `ci(lint)` is
  `area:ci`.

**A dependency bump carries the label pair and nothing else.** Renovate attaches
`kind:tooling` and `area:packaging` to every pull request it opens, through the
`labels` key in `.github/renovate.json`, so a bump is findable from the issue
list and from search; it takes no milestone and no project item, on purpose —
bumps outnumber the plan's own pull requests, and on the `v1.0.0` milestone they
would drown the only question it answers. The `chore(main): release …` pull
request is release-please's, and carries only its own `autorelease:` labels.

### What an issue says

Every issue is written the same way, so a reader who has seen one can find their
way round the next. The title is the Conventional Commit the pull request will
carry — `type(scope): lowercase imperative phrase`, `!` after the scope for a
breaking change, at most 72 characters — where the scope names the part of the
plugin the change lives in: `watch`, `build`, `config`, `options`, `types`,
`vite`, `webpack`, `readme`, `agents`, `package`, `exports`, `ci`, `lint`,
`renovate`, `release`, `tests`. A spike is not a pull request yet, so its title
is the question: `Spike: are token sources inside node_modules ever watched?`.

The body has these sections, in this order, and no headings:

1. **What is wrong.** The defect or the gap and its consequence for a consumer,
   then the mechanism, citing `file:line` and quoting code or measured output
   where that is what makes the claim checkable. Numbers only when they were
   measured.
2. **What to change.** The proposal, naming functions and files. Where two
   candidates exist, both, and what decides between them. Where the obvious fix
   is unsound or this file records why it must not be done, a bold sentence
   saying so.
3. **How to know it worked.** The acceptance criterion as steps a reviewer can
   perform, ending with "Prove the test can fail by reverting the fix" wherever
   a test is involved.
4. `**Phase:** … · **Size:** … · **Kind:** … · **Area:** …` — the four
   judgements, repeated in the body so they survive an export and a search.
5. **Files** — what the change touches, relative to the repository root.
6. **Depends on** — the issues that must merge first, as `#N`; omitted when
   there are none.
7. **Resolves** — the finding ids from the evaluation, so the issue traces back
   to its evidence; omitted when there are none.
8. **Definition of done** — a checklist: the change is made; a test pins it and
   fails when the change is reverted (for Docs: what it claims is checked
   against the code; for Tooling: the check fails on the case it exists to
   catch; for a Spike: the answer is written down with the experiment);
   `npm run lint`, `npm run build`, `npm test` and `npm run package:check` are
   green; the pull request title is the Conventional Commit above.
9. A footer naming where the item came from, in italics.

### Setting the fields

`gh issue create` sets the three issue-side fields in one call —
`--label kind:fix --label area:watching --milestone v1.0.0 --type Bug` — and the
milestone and labels are what `gh issue edit` changes later. The rest is
GraphQL:

- **Priority and Effort go through `setIssueFieldValue`, both in one call.** It
  takes the issue's node id as `issueId` and a required `issueFields` list,
  where each entry carries a `fieldId` and one of `singleSelectOptionId`,
  `textValue`, `dateValue`, `numberValue`, `multiSelectOptionIds` or `delete`.
  Two fields are therefore two entries rather than two mutations:

  ```graphql
  setIssueFieldValue(input: {issueId: $issue, issueFields: [
    {fieldId: "IFSS_kgDOAh5jjg", singleSelectOptionId: "IFSSO_kgDOA7UWUg"},
    {fieldId: "IFSS_kgDOAh5jkQ", singleSelectOptionId: "IFSSO_kgDOA7UWWA"}
  ]}) { clientMutationId }
  ```

  An earlier schema took `fieldId` and `value` beside `issueId`, and that form
  is now rejected before it runs — `Argument 'issueFields' … is required`, and
  `doesn't accept argument 'fieldId'`. The field and option ids are the
  repository's:
  `repository { issueFields(first: 10) { nodes { ... on IssueFieldSingleSelect { id name options { id name } } } } }`
  lists them.

- **The project item** comes from `addProjectV2ItemById` with the project's id
  and the issue's node id, and its five fields from
  `updateProjectV2ItemFieldValue` with the item id, the field id and the option
  id, which `gh project field-list 3 --owner kanso-labs --format json` lists.

**Project fields are GraphQL-only, and that budget is small.** There is no REST
route to a project item, and GraphQL allows 5,000 points an hour against a limit
that is separate from REST's — so a bulk edit over the board is the one thing
here that can run out of road halfway. Both halves batch, so the seven
single-select fields an item carries take two mutations rather than seven: one
`setIssueFieldValue` holding both native fields in its `issueFields` list, and
**one mutation with aliased `updateProjectV2ItemFieldValue` calls** for the five
project ones. It is the difference between seven points an item and two, and the
limit, once hit, locks out every GraphQL call including the reads that would
tell you what landed.

**An archived item is read-only.** Writing a field to one fails with _The item
is archived and cannot be updated_, so setting one means unarchiving, writing,
and archiving again. Worth knowing before a bulk edit over the whole board
reports failures that are not failures of the edit.

**A view's grouping is not settable from the API.** `createProjectV2View` and
`updateProjectV2View` take a name, a layout, a filter and the visible fields,
and nothing else — so the Roadmap board's column field and the By area table's
grouping were set by hand once and stay wherever the last person left them.

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
names `.js`. Delete the line and the build still succeeds and the tests still
pass; publint is the only thing that fails, once per condition now pointing at a
file that is not there. Before `npm run package:check` existed, this shipped a
package that resolved to nothing with every check green. A project that reaches
the same extensions through `platform: 'neutral'` needs no such line, so copying
another repository's config rather than its outcome reintroduces this.

**The exports map says `default`, not `import`, and the difference is whether
CommonJS works at all.** With only an `import` condition a `require()` of this
package fails outright with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Under `default`,
Node resolves the same ESM file and serves the caller through `require(esm)`.
That one word is the whole of this package's CommonJS support, so renaming it to
`import` — which reads like a tidy-up next to a `type: module` package — removes
support for every CommonJS consumer. publint reports the rewritten map as "All
good!"; what catches it is the `require.resolve` half of
`scripts/check-package.mjs`, and `tests/index.test.ts` pins the condition
itself.

**A `require()` of a target entry returns the namespace, so callers need
`.default`.** Node hands a `require(esm)` caller the module namespace object,
not the default export. That was briefly untrue: while the package shipped a
CommonJS build, tsdown's `cjsDefault` rewrote the four single-default target
entries to `module.exports = fn`, and `require()` gave the function directly.
Dropping that build put the `.default` hop back. The README documents the
current form, and `scripts/check-package.mjs` requires all four target entries
and asserts the hop, so the two cannot drift apart quietly.

**`sideEffects: false` is a claim about module scope, not about what the plugin
does.** The plugin writes files constantly, but only once a bundler calls a
hook, and that is not what the field is about: it says a consumer who imports
nothing from a module loses nothing by having it dropped. That holds here.
`atomicVolume` is an `Object.create` over `node:fs`, which builds a new object
rather than mutating the imported one; `createUnplugin` is annotated
`/* #__PURE__ */`; the four target entries are a property access each. Add a
top-level statement that does something observable — writing a file at load,
mutating an import, registering a global — and the field becomes a lie bundlers
will act on. Nothing enforces it: publint asks for the field and passes either
way, and no test can see a side effect that has not been written yet.

**Three things stop an infinite rebuild loop, and the filter is only the
first.** Consuming code imports the generated file, so every regenerate is
itself a module-graph change the host reacts to, and a loop closes through any
entry point that compiles without asking whether it should.

1. `matchesWatchedFile` answers whether a changed path matches a watch pattern.
   Without it `watchChange` fires for any changed file in the module graph and
   rebuilds on the plugin's own output.
2. `generatedDestinations` answers what the plugin itself wrote, and
   `isWatchedSource` subtracts it. The pattern cannot: a `buildPath` inside a
   `source` directory is a supported layout, and its output matches the very
   glob that produced it. Both watch entry points ask through `isWatchedSource`
   rather than the matcher directly.
3. `buildStart` skips its compile on a watch re-entry, because rollup, rolldown
   and webpack all re-enter it on every rebuild — unplugin's webpack adapter
   awaits `watchChange` and then `buildStart` in one `make` tap. `watchChange`
   has already decided the rebuild for that cycle, and compiling again here is
   what made every regenerate produce the next one. Under `rollup --watch` that
   was about ten bundles a second, forever.

Underneath all three, a write whose bytes match the destination skips the
`rename`, so a rebuild that renders what is already there emits no filesystem
event at all. That is the backstop for the targets none of the three cover.
`tests/index.test.ts` pins each of these, the last one through a real
`rollup.watch()` run rather than a hand-built plugin context. Do not "simplify"
any of them.

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

**The `configureServer` escape hatch is redundancy, deliberately kept.** It used
to be justified by Vite not reliably invoking `watchChange` while serving. That
is not true of any Vite this package supports: 6, 7 and 8 all call
`pluginContainer.watchChange` from their own file-change handler, and with
either path stubbed out an edit still rebuilds exactly once. What keeps both is
that the declared peer range is wider than the three versions that were
measured, and that a duplicate trigger now costs nothing.

**One scheduler is what makes that true, and it is load-bearing beyond the
duplication.** Both watch entry points call `schedule` rather than `runBuilds`:
a trailing debounce collapses a burst — an editor's save-all, a checkout, a
formatter rewriting a directory — into one rebuild, and a single in-flight chain
means a trigger arriving mid-build queues one follow-up instead of starting a
second build beside it. Without it, one token edit under a dev server produced
two overlapping builds and a four-file change produced ten. That overlap is the
same one `runBuilds` avoids internally by building its configurations one after
another, reintroduced one level up.

**A directory's mtime is not an input signal, and reading it as one made nothing
ever up to date.** `expandPatterns` deliberately registers each pattern's static
parent directory alongside the files matching it today, so a token file created
tomorrow is watched. `isUpToDate` walks the same list and must skip the
directories in it: a directory's mtime moves whenever an entry is renamed inside
it, and the atomic write renames every generated file into place. With a
`buildPath` inside a `source` directory — the layout `generatedDestinations`
exists to support — the build itself became the newest thing the comparison
could see, so every configuration compiled every time and the skip looked
implemented but dead. It survived the whole unit suite and only showed up
against a real consumer. `tests/index.test.ts` pins that layout directly.

**The scheduler serialises one plugin instance; `compilesInFlight` serialises
the process.** They solve the same problem at different scopes and neither
replaces the other. `hasCompiled` and the scheduler are closure state inside
`unpluginFactory`, so they see only their own instance — and one process
routinely holds several. A single `vitest run` with two test projects and
browser mode stands up five Vite servers, each with its own instance, each
running `buildStart`; the last two start together. `compilesInFlight` is a
module-level map keyed by `buildKey`, so the second waits on the first's promise
instead of starting a second compile onto the same destinations.

It **coalesces rather than caches** — the entry is dropped the moment the
compile settles, so a later `buildStart` still compiles. Skipping one whose
output is already current is a different mechanism, and is #212's up-to-date
check. That division is why this handles only the instances that start together:
the ones that arrive in turn have output on disk to compare against, and a
shared promise is the only thing that can speak for the ones that do not.

`buildKey` serialises functions by source rather than letting `JSON.stringify`
drop them, because an inline `format` or `transform` is exactly what tells two
otherwise identical configurations apart. It returns `null` for a configuration
that will not serialise, which opts that one out of sharing rather than giving
it a wrong identity.

**Vite's dev-server watcher cannot be reached after `configResolved`, and its
ignore list only grows.** It is built from the resolved config with
`**/.git/**`, `**/node_modules/**`, `**/test-results/**` and the cache directory
already in the ignore list, and the consumer's own `server.watch.ignored`
entries are spread in _after_ them. Entries are appended, never subtracted, so
`server.watcher.add()` cannot reach a path an earlier entry covers — which made
a token package resolved through `node_modules`, the shape of every workspace,
build correctly once and then never rebuild, silently.

The fix amends `config.server.watch.ignored` in `configResolved`, and that hook
is the last one that can. `configureServer` receives `server.watcher` as a
parameter, so by then it exists and a negation changes nothing — measured on
Vite 6.4.3, 7.3.6 and 8.3.0, along with the confirmation that amending it in
`configResolved` does reach the watcher on all three. The `config` hook works
too and is the more sanctioned place, but it has no resolved `root` to resolve
token paths against, so it would have to guess at what Vite computes.

**The negation names each file, and must not be broadened.**
`!**/node_modules/**` works and hands the entire dependency tree to the watcher;
a leaf-file negation was measured to be enough, because chokidar still reaches a
path that was explicitly added. Un-ignoring the package directory or the whole
tree buys nothing and costs thousands of watched files.

**`configResolved` resolves configurations now, and that has two consequences.**
It needs the watch list to derive the negations, so it calls a consumer's
`config` function — which is why `isWatching` is set there, before the
resolution, rather than only in `configureServer`: the function has to be told
`watch: true` on that call as much as on any later one. And the result is handed
to `configureServer` through `startupResolved` rather than resolved again, so
one dev-server start-up still calls the consumer's function once at this stage.
Whatever else moves into that hook, the Vite logger assignment must stay _above_
its `command !== 'serve'` return — `vite build` takes that return and needs the
logger just as much.

**Hook order under Vite decides what the first `config` function is told.**
`configResolved` runs, then `configureServer`, and `buildStart` only when the
plugin container comes up — so `configureServer`'s own `resolveConfigs` call
happens before any plugin context has reported `meta.watchMode`. It therefore
sets `isWatching` itself, because a dev server watches by definition, and
without that the first `config` function of the process is handed `watch: false`
while a dev server starts up around it.

**What each host can say about a build, and what has to be derived.** Only Vite
reports a command and a mode; the rest is read where it exists and followed from
`command` where it does not, rather than guessed at.

| Host     | `command`        | `mode`                  | `watch`              |
| -------- | ---------------- | ----------------------- | -------------------- |
| Vite     | `config.command` | `config.mode`           | `meta.watchMode`     |
| Rollup   | always `'build'` | follows `command`       | `meta.watchMode`     |
| Rolldown | always `'build'` | follows `command`       | `meta.watchMode`     |
| Webpack  | always `'build'` | `compiler.options.mode` | `compiler.watchMode` |

webpack's `buildStart` context carries no `meta` at all, so neither field can
come from there — both come off the compiler the `webpack` hook is handed.
`compiler.watchMode` is only set once `watch()` has been called, which is after
that hook runs, so it is read per compile in `beforeCompile` rather than when
the plugin is installed. A rolldown hook runs at `generate()` rather than at
`rolldown()`, which is worth knowing before writing a probe that sees nothing.

**A host's error channel is not a place to report to.** Rollup's `this.error`
aborts the bundle — measured: a `buildStart` calling it ends the run with
`THREW: [plugin err-probe] fatal?` — so a failure reported through it stops
every build that reports one, which is `failOnError`'s decision and not the
logger's. The report goes on the warning channel on every host, and webpack's
lands in `compilation.warnings` rather than `compilation.errors` for the same
reason: `failOnError: false` has to leave the build passing.

**webpack's compile runs before its compilation exists.** unplugin gives webpack
no `this.warn` at all — its `buildStart` context is exactly `parse`,
`addWatchFile`, `emitFile`, `getWatchFiles` and `getNativeBuildContext`,
measured — and the plugin compiles in `beforeCompile`, which webpack awaits
_before_ creating the compilation a message would attach to. So messages are
buffered and flushed on `compilation`. A `beforeCompile` that throws ends the
run without ever creating one, which is exactly the case that produced the
message, so `failed` and `done` drain whatever is still held to the console.

**Colour is three signals in order, never one conjunction.**
`!NO_COLOR && FORCE_COLOR !== '0' && stream.isTTY` looks like it honours all
three and never honours `FORCE_COLOR=1` on a non-TTY — the TTY check has the
last word — which is the single job that variable has. `NO_COLOR` first and
absolute, then `FORCE_COLOR`, then `TERM=dumb`, then `isTTY`. stdout and stderr
are asked separately: `build 2>err.log` leaves one a terminal and the other a
file.

**A public callback typed `=> void` makes a consumer's `async` handler a lint
error.** TypeScript's void-return rule accepts one either way, so this does not
show up in a type-check — but oxlint's type-aware
`typescript/no-misused-promises` rejects `onBuildEnd: async () => {…}` against a
`=> void` property, and a consumer running the same recommended rule set gets
the same error in their own config file. The three `onBuild*` hooks therefore
return `Promise<void> | void`, which documents that an `async` hook is supported
and lets one be written without a suppression. It is not a promise to await what
comes back, and nothing does.

Its mirror on this side: a hook's return value has to be **captured** so a
rejection can be caught, and `typescript/no-confusing-void-expression` pushes
exactly the other way, asking for a block-bodied arrow that throws the value
away. Taking that advice reintroduced the unhandled rejection the hook wrapper
exists to prevent, with every check green — the test that caught it asserts on
Node's `unhandledRejection` event rather than on the process surviving, because
by then the run is already over.

**Vite has no frame for taking an error overlay down, so the clear is an empty
update.** Its client creates the overlay on an `error` payload and removes it
when an `update` arrives — `{ type: 'update', updates: [] }` therefore dismisses
it and then iterates nothing, reloading no page and touching no stylesheet.
There is no `clear-error` type to reach for, and sending `full-reload` instead
would throw away the page's state to achieve the same thing.

That update is not free, which is why `configureServer` sends one only when an
overlay of this plugin's is actually showing. Vite's client spends a one-time
`isFirstUpdate` flag on the first update it receives, and an overlay standing at
that moment makes it reload the page rather than clear. A clear per successful
rebuild would spend that flag on a build nothing was wrong with.

**The overlay reads its outcome from `runBuilds`, not from whether a caller
caught something.** `notifyBuildOutcome` is called inside `runBuilds` ahead of
the `failsTheBuild` decision, and that ordering is the whole point: under the
dev server's default a failed rebuild is reported and _not_ rethrown, so a
caller's `catch` never runs and the rebuild is indistinguishable from one that
worked. `failOnError` decides whether the host stops; `errorOverlay` decides
whether the browser is told. Wiring the second to the first would silence it on
the only configuration where it matters.

**A one-shot build only compiles once, in `buildStart`.** Anything without a
persistent watch mode — `rolldown build` or `tsdown` with no `--watch` — gets no
rebuild-on-change, and that is expected rather than a bug to fix.

**What rolldown does with a token edit depends on the platform, so neither
answer can be relied on.** `this.addWatchFile()` is accepted by rolldown 1.2.9
either way, but what happens next is not the same everywhere: on macOS a file
registered through it is watched by nothing, so a token edit reaches no hook at
all, while on the Linux CI runner the same edit reached a rebuild and updated
the generated file. Both were measured on this repository's own fixture — the
macOS half with a bare probe plugin that saw no `watchChange` and no second
`buildStart` for a file outside the module graph, and the Linux half as a CI
failure of a test that had asserted the macOS behaviour.

So do not write a test that asserts a token edit under `rolldown.watch()` either
arrives or does not, and do not tell a consumer that rolldown watches tokens.
What holds on both platforms is the module graph: the generated file is in it,
so every regenerate is a change rolldown reacts to, and the guards that matter
there are the ones stopping that from becoming a loop. `tests/targets.test.ts`
asserts only that — an entry edit rebuilds and then settles.

**`release_created` is compared against the string `'true'` on purpose.** The
output carries the string `"false"` when release-please runs and decides not to
cut a release, and a bare truthiness test passes on that — publishing every
merge to npm.

**commitlint is installed but never runs.** `@commitlint/cli`,
`@commitlint/config-conventional` and `.commitlintrc.json` are all present, and
`.husky/` carries a `pre-commit` hook — but that hook runs lint-staged, not
commitlint. There is no `commit-msg` hook and no workflow invoking one, so a
malformed type reaches `main` unnoticed and lands in the changelog, and the pull
request title is on the author to get right.

The hook directory existing makes this easier to misread as solved than it was
when the directory held nothing but husky's own `_`.
