import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Claude Code puts its git worktrees under `.claude/worktrees/`, and each
    // one carries its own copy of `tests/index.test.ts`. Vitest's default
    // `include` matches every copy, so a plain `npm test` at the root runs the
    // suite once per worktree — reporting another branch's tests as this
    // checkout's result. The directory is gitignored, so CI's clean checkout
    // never sees any of this; it only bites local runs. Spread the defaults
    // rather than replacing them: `exclude` overrides wholesale, and dropping
    // `**/node_modules/**` would run every dependency's tests.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})
