import eslintJs from '@eslint/js'
import eslintPluginPerfectionist from 'eslint-plugin-perfectionist'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import typescriptEslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'coverage']),
  {
    extends: [
      eslintJs.configs.recommended,
      ...typescriptEslint.configs.recommended,
      eslintPluginPerfectionist.configs['recommended-natural'],
      eslintPluginPrettierRecommended,
    ],
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
  },
])
