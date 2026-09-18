import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `text` prints the table into the job log, and `cobertura` writes the
    // file that `Upload coverage report` hands to GitHub. `include` is spelled
    // out because coverage otherwise reports only the files a test happened to
    // import, so a source file nothing covers would be missing from the total
    // rather than counted as zero.
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      // A floor rather than a target. The uploaded report tells a reader what
      // coverage is; only this makes a drop fail the `Test` check, which is
      // the same reason `Build` ends in `npm run package:check` rather than
      // leaving the packed output merely visible.
      //
      // Re-based after the two rebuild error paths were covered. Measured over
      // three consecutive runs, all four identical every time:
      //
      //   Statements  96.13% (572/595)
      //   Branches    86.91% (332/382)
      //   Functions   97.67% (84/86)
      //   Lines       97.39% (523/537)
      //
      // Branches used to swing — the comment these numbers replace recorded
      // 82.32 to 82.87, because the watcher cases take different paths
      // depending on what the filesystem reports and when. It did not swing at
      // all across these runs, but three runs is not a proof of zero variance,
      // so the margin still absorbs one: a single branch is 0.26 points here.
      //
      // The floors sit about two points under each measurement, which is
      // several units of whatever the metric counts and still far above where
      // deleting a test file lands. They are floors rather than targets — the
      // uploaded report is what tells a reader the actual number.
      thresholds: {
        branches: 85,
        functions: 95,
        lines: 95,
        statements: 94,
      },
    },
    // Claude Code puts its git worktrees under `.claude/worktrees/`, and each
    // one carries its own copy of `tests/index.test.ts`. Vitest's default
    // `include` matches every copy, so a plain `npm test` at the root runs the
    // suite once per worktree — reporting another branch's tests as this
    // checkout's result. The directory is gitignored, so CI's clean checkout
    // never sees any of this; it only bites local runs. Spread the defaults
    // rather than replacing them: `exclude` overrides wholesale, and dropping
    // `**/node_modules/**` would run every dependency's tests.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // The file `Upload test results to Codecov` hands over. It goes under
    // `.vitest/`, named for the tool that writes it the way `.vite/` beside it
    // in `.gitignore` already is, so one ignored directory covers this report
    // and anything Vitest writes next to it.
    //
    // `default` stays in the reporter list so the job log still reads the
    // same — a bare `--reporter=junit` replaces the console output rather
    // than adding to it.
    //
    // Both legs of the `Test` job write this, and the last write is the one
    // uploaded. That is deliberate: a failure on the Node floor then reaches
    // Codecov instead of being hidden by the passing run before it. Coverage
    // is the other way round, measured once on the first leg and left alone,
    // because the floor leg does not re-measure it.
    outputFile: { junit: '.vitest/test-results.junit.xml' },
    reporters: ['default', 'junit'],
  },
})
