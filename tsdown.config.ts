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
  // which every `import` condition in `package.json` — and `module` and
  // `types` with them — points away from. Setting it back to false restores
  // `.js`/`.cjs` and `.d.ts`/`.d.cts`. Removing this line republishes the
  // package at paths its own exports map does not resolve, and nothing fails
  // locally to tell you. kanso-ui lands on the same extensions by way of
  // `platform: 'neutral'`, which is the wrong reason to copy here.
  fixedExtension: false,
  // The build warns MIXED_EXPORTS over src/index.ts, which exports both named
  // members and a default, and suggests `outputOptions: { exports: 'named' }`
  // to silence it. Do not take that suggestion. Forcing named mode also
  // overrides `cjsDefault`, which is what rewrites the four single-default
  // target entries to `module.exports = fn`; with it set, dist/cjs/vite.cjs
  // reverts to `exports.default = fn` and the published CJS shape silently
  // changes back. Measured, not assumed. The warning is the cheaper cost.
  format: {
    cjs: { outDir: 'dist/cjs' },
    esm: { outDir: 'dist' },
  },
  sourcemap: true,
  tsconfig: 'tsconfig.lib.json',
  unbundle: true,
})
