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
      // Measured over six consecutive runs after the phase 4 tests landed:
      // statements, functions and lines were identical every time at 94.51,
      // 95.55 and 96.19, and branches moved between 82.32 and 82.87 — the
      // watcher cases take different paths depending on what the filesystem
      // reports and when. The margin below absorbs that swing and a slower
      // runner's, and is still far above where deleting a test file lands.
      thresholds: {
        branches: 78,
        functions: 92,
        lines: 92,
        statements: 90,
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
    // The file `Upload test results to Codecov` hands over. It goes in a
    // directory of its own beside `coverage/`, so the two reports this job
    // produces sit next to each other and one gitignore entry covers each.
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
    outputFile: { junit: 'test-results/junit.xml' },
    reporters: ['default', 'junit'],
  },
})
