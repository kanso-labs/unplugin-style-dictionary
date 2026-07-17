import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

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
})
