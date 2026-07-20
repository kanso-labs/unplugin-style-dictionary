# Changelog

## [0.2.1](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.0...unplugin-style-dictionary-v0.2.1) (2026-07-20)


### Bug Fixes

* filter watchChange the same way configureServer already does ([65c3020](https://github.com/kanso-labs/unplugin-style-dictionary/commit/65c3020d49a791b137bcc7a05d23e4747e383769))
* filter watchChange the same way configureServer already does ([cce9d76](https://github.com/kanso-labs/unplugin-style-dictionary/commit/cce9d76354fd94aa4aec23d4cf70d28c3f0bdca4))

## [0.2.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.1.0...unplugin-style-dictionary-v0.2.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* package renamed from @kanso-labs/vite-plugin-style-dictionary to @kanso-labs/unplugin-style-dictionary. The root import no longer resolves to a ready-to-use Vite plugin; import the bundler-specific entry point instead (e.g. `@kanso-labs/unplugin-style-dictionary/vite`). The exported options type is renamed from VitePluginStyleDictionaryOptions to UnpluginStyleDictionaryOptions (same shape: config, watch, silent).

### Features

* convert to unplugin-based plugin for Vite and Rolldown support ([27b1c16](https://github.com/kanso-labs/unplugin-style-dictionary/commit/27b1c165ad37562f5e544e6b539eaed3f2c79dec))
* enhance design token compilation and logging in vitePluginStyleDictionary ([0185e5c](https://github.com/kanso-labs/unplugin-style-dictionary/commit/0185e5cafa3bba784d9cf6f0dd0abeb30a779f70))
* implement release workflow with npm publishing steps ([6d958bb](https://github.com/kanso-labs/unplugin-style-dictionary/commit/6d958bbe79478540129dbdeeab72cb46b0748b59))

## [0.1.0](https://github.com/kanso-labs/vite-plugin-style-dictionary/compare/vite-plugin-style-dictionary-v0.0.1...vite-plugin-style-dictionary-v0.1.0) (2026-05-21)


### Features

* enhance design token compilation and logging in vitePluginStyleDictionary ([0185e5c](https://github.com/kanso-labs/vite-plugin-style-dictionary/commit/0185e5cafa3bba784d9cf6f0dd0abeb30a779f70))
* implement release workflow with npm publishing steps ([6d958bb](https://github.com/kanso-labs/vite-plugin-style-dictionary/commit/6d958bbe79478540129dbdeeab72cb46b0748b59))
