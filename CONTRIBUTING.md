# Contributing

We are open to, and grateful for, any contributions made by the community. By
contributing to this project, you agree to abide by the
[code of conduct](https://github.com/kanso-labs/unplugin-style-dictionary/blob/main/CODE_OF_CONDUCT.md).

## Reporting Issues and Asking Questions

Before opening an issue, please search the
[issue tracker](https://github.com/kanso-labs/unplugin-style-dictionary/issues)
to make sure your issue hasn't already been reported.

A bug report needs three things this plugin cannot work without: **which bundler
and which version**, **which version of `style-dictionary`**, and **which
version of Node**. This package targets five bundlers from one implementation
and declares peer ranges for each, so a report that names none of them cannot be
placed against them. The bug report form asks for all three.

To report a security vulnerability, do not open an issue — see
[SECURITY.md](SECURITY.md).

## Development

Fork, then clone the repo:

```shell
git clone https://github.com/your-username/unplugin-style-dictionary.git
```

Install with the Node version in [`.tool-versions`](.tool-versions). CI resolves
it from that file, and an older npm rewrites `package-lock.json`. If
`node --version` disagrees:

```shell
mise exec node@"$(awk '/^nodejs/{print $2}' .tool-versions)" -- npm install
```

### The four commands

These are what CI runs, and between them they are the whole gate:

```shell
npm run lint           # oxlint, then ESLint, then oxfmt --check
npm run build          # tsc -b, then tsdown into dist/
npm test               # vitest, one run, no watch
npm run package:check  # publint, attw, then scripts/check-package.mjs
```

`npm run package:check` reads `dist/`, so it needs a build first.
`npm run peers:check` is the slower one that packs the tarball and builds it
against both ends of every declared peer range; `Build` runs it, and it is worth
running locally when you touch the exports map or the peer declarations.

**`oxfmt` formats this repository, not Prettier**, and it covers Markdown, JSON
and YAML as well as TypeScript. `npm run lint -- --fix` will not reformat
anything — reach for `npm run format`.

### Tests

`tests/` drives real bundlers against real files in temporary directories rather
than mocking Style Dictionary: a real Vite dev server, a real `rollup.watch()`,
a real `webpack()` compile, a real `rspack()` compile, and all five targets
through their own entry points. A new hook needs a matching caller in
`tests/index.test.ts` — calling one bare leaves `this` undefined and the failure
reads as a plugin bug.

The suite prints nothing. If you add a test that provokes the plugin's failure
report, spy on `console.error`, **assert the message is there**, and restore in
a `finally`. You can check the whole suite is quiet with:

```shell
npx vitest run --reporter=verbose 2>&1 | grep -E '^std(out|err) \|'
```

That should print nothing.

### New Features

Please open an issue with a proposal for a new feature or refactoring before
starting on the work. We don't want you to waste your efforts on a pull request
that we won't want to accept.

## Submitting Changes

- Open a new issue in the
  [issue tracker](https://github.com/kanso-labs/unplugin-style-dictionary/issues).
- Fork the repo.
- Create a new feature branch based off the `main` branch.
- Submit a pull request, referencing any issues it addresses.

**Your pull request title matters more than your commit messages.** Pull
requests are squash-merged with the title as the commit subject and an empty
body, so that title becomes the only commit on `main` and branch commits never
reach history. It is also the single input to `release-please`:

| Title starts with   | What gets released   |
| ------------------- | -------------------- |
| `feat:`             | a minor              |
| `fix:` or `deps:`   | a patch              |
| `type!:` (any type) | a minor, below 1.0.0 |
| anything else       | nothing              |

`Lint` checks the title with commitlint, so a malformed one fails the build.
Write your branch commits conventionally anyway — they are what a reviewer reads
while the pull request is open.

Please try to keep your pull request focused in scope and avoid including
unrelated commits.

After you have submitted your pull request, we'll try to get back to you as soon
as possible. We may suggest some changes or improvements.

Thank you for contributing!

## Attribution

This Contributing Guide is adapted from the
[React Redux Contributing Guide](https://github.com/reduxjs/react-redux/blob/master/CONTRIBUTING.md).
