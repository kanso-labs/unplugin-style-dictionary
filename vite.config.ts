import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dts from 'vite-plugin-dts'
import { configDefaults, defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: path.resolve(dirname, 'src/index.ts'),
        rolldown: path.resolve(dirname, 'src/rolldown.ts'),
        rollup: path.resolve(dirname, 'src/rollup.ts'),
        vite: path.resolve(dirname, 'src/vite.ts'),
        webpack: path.resolve(dirname, 'src/webpack.ts'),
      },
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'style-dictionary',
        'unplugin',
        'vite',
        'rolldown',
        'rollup',
        'webpack',
        /^node:/,
        'path',
        'fs',
        'url',
      ],
      output: {
        exports: 'named',
      },
    },
    sourcemap: true,
  },
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
    }),
  ],
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
