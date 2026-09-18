# Security Policy

## Supported Versions

Only the latest release is maintained. This package is below 1.0.0, so fixes
land on `main` and ship in the next release rather than being backported.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting, which is enabled on this
repository:
[Report a vulnerability](https://github.com/kanso-labs/unplugin-style-dictionary/security/advisories/new).
That opens a private advisory only the maintainers can see, and it is the
preferred channel because the discussion, the fix and the CVE all stay in one
place.

If you cannot use it, email **kanso-org@rodrigosn.com**.

Please include the three things any report of this plugin needs — the bundler
and its version, the `style-dictionary` version, and the Node version — plus the
steps to reproduce.

We will acknowledge a report and tell you whether we consider it a
vulnerability. If it is, we will agree a disclosure timeline with you before
publishing.

## Scope

This package compiles design tokens at build time. It reads configuration files
and token sources from the host project and writes generated files, and the
function form of its `config` option runs code the host supplies. It is a
build-time dependency and ships nothing to a browser.

Worth knowing when judging whether something is a vulnerability here:

- **Default config discovery reads and, for `.js` and `.mjs`, runs a file from
  the project root.** Four names are tried and a candidate is validated before
  being adopted, but reading a module means running it, so validation happens
  after any side effects. `config: false` turns discovery off.
- **Every `npm ci` in CI passes `--ignore-scripts`**, and automerged dependency
  upgrades wait out a release-age grace period before they can land.
