import { codecovRollupPlugin } from '@codecov/rollup-plugin'
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
  // does not resolve. Nothing in the build or the test suite says so; the
  // publint half of `npm run package:check` is what fails.
  fixedExtension: false,
  format: ['esm'],
  plugins: [
    // Codecov's rollup plugin rather than its Vite one, because this is what
    // builds the published package — `vite.config.ts` here configures Vitest
    // and nothing else, so a Vite plugin would watch a build that never runs.
    // tsdown drives rolldown, whose plugin API is rollup's, and the plugin
    // takes its stats off the emitted bundle rather than out of rollup itself.
    //
    // `enableBundleAnalysis` is what keeps a local `npm run build` inert: the
    // token is a repository secret, so it is undefined everywhere but CI, and
    // the plugin then neither writes its stats file nor uploads anything.
    //
    // The stats file it writes lands in `dist/`, which `files` in
    // package.json publishes wholesale — the plugin deletes it again once the
    // upload returns, which is what keeps it out of the tarball.
    codecovRollupPlugin({
      bundleName: 'unplugin-style-dictionary',
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      uploadToken: process.env.CODECOV_TOKEN,
    }),
  ],
  sourcemap: true,
  tsconfig: 'tsconfig.lib.json',
  unbundle: true,
})
