import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(dirname, 'src/index.ts'),
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['style-dictionary', 'vite', /^node:/, 'path', 'fs', 'url'],
      output: {
        exports: 'named',
      },
    },
    sourcemap: true,
  },
  plugins: [
    dts({
      bundleTypes: true,
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
    }),
  ],
})
