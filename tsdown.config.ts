import { defineConfig } from 'tsdown'

export default defineConfig({
  dts: true,
  entry: [
    'src/index.ts',
    'src/rolldown.ts',
    'src/rollup.ts',
    'src/vite.ts',
    'src/webpack.ts',
  ],
  // tsdown derives `fixedExtension` from `platform`, and `platform` defaults
  // to `node` — correct for a build-time plugin that reaches for node:fs,
  // node:path, node:url and node:zlib. That default emits ESM as `.mjs`,
  // which every condition in `package.json` — and `module` and `types` with
  // them — points away from. Setting it back to false restores `.js`.
  // Removing this line republishes the package at paths its own exports map
  // does not resolve, and nothing fails locally to tell you.
  fixedExtension: false,
  format: ['esm'],
  sourcemap: true,
  tsconfig: 'tsconfig.lib.json',
  unbundle: true,
})
