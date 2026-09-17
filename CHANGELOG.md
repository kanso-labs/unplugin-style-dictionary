# Changelog

## [0.8.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.7.0...unplugin-style-dictionary-v0.8.0) (2026-09-17)


### Features

* **config:** give the config function a context argument ([#288](https://github.com/kanso-labs/unplugin-style-dictionary/issues/288)) ([63f2a3f](https://github.com/kanso-labs/unplugin-style-dictionary/commit/63f2a3ff06abc58605fb548881f72d44c54d8fe7))
* **options:** add onBuildStart, onBuildEnd and onBuildError hooks ([#286](https://github.com/kanso-labs/unplugin-style-dictionary/issues/286)) ([48dd8d1](https://github.com/kanso-labs/unplugin-style-dictionary/commit/48dd8d193980c4024175ae18bbbf43cb64112976))
* **vite:** push failed rebuilds to the error overlay ([#284](https://github.com/kanso-labs/unplugin-style-dictionary/issues/284)) ([ca38af6](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ca38af61c022447dbaea9cd32ed579fd598592a0))


### Bug Fixes

* **build:** respect NO_COLOR and route messages through the host ([#287](https://github.com/kanso-labs/unplugin-style-dictionary/issues/287)) ([415efd6](https://github.com/kanso-labs/unplugin-style-dictionary/commit/415efd60e8f6cd308ff9047c3cd96f7f156a74ea))

## [0.7.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.6.2...unplugin-style-dictionary-v0.7.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **exports:** make the watch filter and the factory internal ([#280](https://github.com/kanso-labs/unplugin-style-dictionary/issues/280))

### Features

* **exports:** make the watch filter and the factory internal ([#280](https://github.com/kanso-labs/unplugin-style-dictionary/issues/280)) ([ceff900](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ceff900d3165cbb820166616a98fa1e7bacd91b5))

## [0.6.2](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.6.1...unplugin-style-dictionary-v0.6.2) (2026-09-17)


### Dependencies

* update codecov/codecov-action action to v7 ([#275](https://github.com/kanso-labs/unplugin-style-dictionary/issues/275)) ([269d5ba](https://github.com/kanso-labs/unplugin-style-dictionary/commit/269d5bafee8f4e24caf978829934066e7b69eb49))

## [0.6.1](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.6.0...unplugin-style-dictionary-v0.6.1) (2026-09-17)


### Performance Improvements

* **build:** skip up-to-date builds and make the size report optional ([#273](https://github.com/kanso-labs/unplugin-style-dictionary/issues/273)) ([08f4b29](https://github.com/kanso-labs/unplugin-style-dictionary/commit/08f4b29f8c0c4a7a26c7f4d981493406d1e3666a))

## [0.6.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.5.3...unplugin-style-dictionary-v0.6.0) (2026-09-17)


### Features

* **types:** export the options type from every target entry ([#268](https://github.com/kanso-labs/unplugin-style-dictionary/issues/268)) ([8dbea55](https://github.com/kanso-labs/unplugin-style-dictionary/commit/8dbea55cd9419ee455ae031cd45472b22005b37f))


### Performance Improvements

* **build:** share one compile between bundler instances in a process ([#271](https://github.com/kanso-labs/unplugin-style-dictionary/issues/271)) ([2699318](https://github.com/kanso-labs/unplugin-style-dictionary/commit/269931885823212ce0dfd58928b4774aef111208))

## [0.5.3](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.5.2...unplugin-style-dictionary-v0.5.3) (2026-09-16)


### Bug Fixes

* **build:** do not fail the build when the size reporter throws ([#261](https://github.com/kanso-labs/unplugin-style-dictionary/issues/261)) ([cf32177](https://github.com/kanso-labs/unplugin-style-dictionary/commit/cf3217776abfac74177b018e48ed58457af23446))
* **package:** narrow engines.node to the intersection of its peers ([#262](https://github.com/kanso-labs/unplugin-style-dictionary/issues/262)) ([425c475](https://github.com/kanso-labs/unplugin-style-dictionary/commit/425c475c7117f89aa84f77c7c3c165f42a8a7fbe))

## [0.5.2](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.5.1...unplugin-style-dictionary-v0.5.2) (2026-09-16)


### Dependencies

* update dependency rolldown to v1.2.9 ([#251](https://github.com/kanso-labs/unplugin-style-dictionary/issues/251)) ([7e61be7](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7e61be7c8bf8cb23ac8686a7bc93f5b356016358))
* update dependency unplugin to v3.4.0 ([#252](https://github.com/kanso-labs/unplugin-style-dictionary/issues/252)) ([98f6a10](https://github.com/kanso-labs/unplugin-style-dictionary/commit/98f6a10bc69fbbd4abc0ed56ae8bf082872a7436))
* update kanso-labs/github-actions action to v3.3.1 ([#256](https://github.com/kanso-labs/unplugin-style-dictionary/issues/256)) ([8a0cbe6](https://github.com/kanso-labs/unplugin-style-dictionary/commit/8a0cbe6404546c9f44d57ec027d00ae6cdf4d8ad))

## [0.5.1](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.5.0...unplugin-style-dictionary-v0.5.1) (2026-09-16)


### Bug Fixes

* **config:** parse json5 and jsonc configs, and drop the cjs claim ([#250](https://github.com/kanso-labs/unplugin-style-dictionary/issues/250)) ([3c16151](https://github.com/kanso-labs/unplugin-style-dictionary/commit/3c161513a83fae8d9103f5a69f54a0e68f6d54d4))
* **config:** thread one resolved config object through build and watch ([#248](https://github.com/kanso-labs/unplugin-style-dictionary/issues/248)) ([70a7a44](https://github.com/kanso-labs/unplugin-style-dictionary/commit/70a7a44b6be00a583b3ba91247900ce91553afd7))
* **webpack:** move the compile off the parallel make hook ([#247](https://github.com/kanso-labs/unplugin-style-dictionary/issues/247)) ([5eef144](https://github.com/kanso-labs/unplugin-style-dictionary/commit/5eef144b65bfdd629d1a585d980f8b0e159f7e5b))


### Performance Improvements

* **watch:** test the watch filter before resolving any config ([#249](https://github.com/kanso-labs/unplugin-style-dictionary/issues/249)) ([cfa5645](https://github.com/kanso-labs/unplugin-style-dictionary/commit/cfa56459bce1df22f32824a36e149f8c61ea977f))


### Dependencies

* update dependency @types/node to v26.6.1 ([#245](https://github.com/kanso-labs/unplugin-style-dictionary/issues/245)) ([12a196e](https://github.com/kanso-labs/unplugin-style-dictionary/commit/12a196ead7db180aee9565d470e957e20753d701))

## [0.5.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.29...unplugin-style-dictionary-v0.5.0) (2026-09-15)


### ⚠ BREAKING CHANGES

* **options:** add failOnError so a broken token set cannot ship green ([#242](https://github.com/kanso-labs/unplugin-style-dictionary/issues/242))

### Features

* **options:** add failOnError so a broken token set cannot ship green ([#242](https://github.com/kanso-labs/unplugin-style-dictionary/issues/242)) ([7753234](https://github.com/kanso-labs/unplugin-style-dictionary/commit/77532341065891e2fdf8341cf2f67470548a900f))
* **options:** add logLevel and stop forcing verbosity to silent ([#243](https://github.com/kanso-labs/unplugin-style-dictionary/issues/243)) ([de435b1](https://github.com/kanso-labs/unplugin-style-dictionary/commit/de435b14c5a659669273057be70b1da81f5909ee))


### Bug Fixes

* **build:** initialise Style Dictionary once, inside the try ([#241](https://github.com/kanso-labs/unplugin-style-dictionary/issues/241)) ([45eab36](https://github.com/kanso-labs/unplugin-style-dictionary/commit/45eab36cc65b88ad5eeea5d6dc84b4ec84a39c78))
* **config:** resolve the build and the watch list against one base ([#244](https://github.com/kanso-labs/unplugin-style-dictionary/issues/244)) ([5489ee7](https://github.com/kanso-labs/unplugin-style-dictionary/commit/5489ee742522b696eb88d0226c399505860a7fa8))
* **watch:** coalesce and serialise rebuilds behind one scheduler ([#238](https://github.com/kanso-labs/unplugin-style-dictionary/issues/238)) ([1f7e8ad](https://github.com/kanso-labs/unplugin-style-dictionary/commit/1f7e8ad84d3310d542d3f606a3b766bcdb73b8ba))


### Dependencies

* update dependency @types/node to v26.6.0 ([#240](https://github.com/kanso-labs/unplugin-style-dictionary/issues/240)) ([f87b95d](https://github.com/kanso-labs/unplugin-style-dictionary/commit/f87b95d9409f0cbd0a0bdb3b03c10bdc269b4d6c))

## [0.4.29](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.28...unplugin-style-dictionary-v0.4.29) (2026-09-15)


### Bug Fixes

* **watch:** expand globs to concrete paths before registering them ([#237](https://github.com/kanso-labs/unplugin-style-dictionary/issues/237)) ([33503af](https://github.com/kanso-labs/unplugin-style-dictionary/commit/33503af4d506b5a5ee9118bcc8c4565beeb1fc0d))
* **watch:** match watch patterns with real glob semantics ([#234](https://github.com/kanso-labs/unplugin-style-dictionary/issues/234)) ([4c85431](https://github.com/kanso-labs/unplugin-style-dictionary/commit/4c85431c967fd708b5240dd91554e21d024379fa))
* **watch:** never treat generated output as a watched source ([#235](https://github.com/kanso-labs/unplugin-style-dictionary/issues/235)) ([63d8f21](https://github.com/kanso-labs/unplugin-style-dictionary/commit/63d8f2177d57a9da2e380a4ffc0b2b78583a0041))
* **watch:** stop buildStart recompiling on every watch re-entry ([#236](https://github.com/kanso-labs/unplugin-style-dictionary/issues/236)) ([b161361](https://github.com/kanso-labs/unplugin-style-dictionary/commit/b161361a674fe7598ba71284f638f94a69039246))


### Dependencies

* update dependency eslint-plugin-perfectionist to v5.11.1 ([#181](https://github.com/kanso-labs/unplugin-style-dictionary/issues/181)) ([5c7b460](https://github.com/kanso-labs/unplugin-style-dictionary/commit/5c7b4602837989b5a6b4fb8be30c9d45d38fdc47))
* update vitest to v5.0.1 ([#182](https://github.com/kanso-labs/unplugin-style-dictionary/issues/182)) ([a518c75](https://github.com/kanso-labs/unplugin-style-dictionary/commit/a518c75526198be9e5992fb8437b6bf8e4044bf1))

## [0.4.28](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.27...unplugin-style-dictionary-v0.4.28) (2026-09-14)


### Performance Improvements

* **package:** declare sideEffects false, and gate the published shape on publint ([#179](https://github.com/kanso-labs/unplugin-style-dictionary/issues/179)) ([7e68606](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7e68606f7df7d2cd22484111e601b3d01c826cc7))


### Dependencies

* update dependency oxfmt to v0.68.0 ([#176](https://github.com/kanso-labs/unplugin-style-dictionary/issues/176)) ([ac2d30a](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ac2d30a496eb66a0ffd0e032f64b3564649cc02e))
* update dependency oxlint to v1.83.0 ([#177](https://github.com/kanso-labs/unplugin-style-dictionary/issues/177)) ([cd37df5](https://github.com/kanso-labs/unplugin-style-dictionary/commit/cd37df5151894896e09d57d983b5e53acdf28d4c))
* update dependency rollup to v4.63.3 ([#175](https://github.com/kanso-labs/unplugin-style-dictionary/issues/175)) ([6c2ea4d](https://github.com/kanso-labs/unplugin-style-dictionary/commit/6c2ea4d6d619255e1a141536823e8711238adb46))

## [0.4.27](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.26...unplugin-style-dictionary-v0.4.27) (2026-09-14)


### Dependencies

* update dependency webpack to v5.111.0 ([#173](https://github.com/kanso-labs/unplugin-style-dictionary/issues/173)) ([28a98a6](https://github.com/kanso-labs/unplugin-style-dictionary/commit/28a98a605d8d2c91c1480bcf59188788e466f597))

## [0.4.26](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.25...unplugin-style-dictionary-v0.4.26) (2026-09-13)


### Dependencies

* update kanso-labs/github-actions action to v3.3.0 ([#171](https://github.com/kanso-labs/unplugin-style-dictionary/issues/171)) ([1426163](https://github.com/kanso-labs/unplugin-style-dictionary/commit/1426163c5534fd50f5d606acf4ab06bbc8b965c7))

## [0.4.25](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.24...unplugin-style-dictionary-v0.4.25) (2026-09-12)


### Dependencies

* update dependency rollup to v4.63.2 ([#169](https://github.com/kanso-labs/unplugin-style-dictionary/issues/169)) ([8d3ad0c](https://github.com/kanso-labs/unplugin-style-dictionary/commit/8d3ad0cb6f6628de4e8c6ac630c58990adad7070))

## [0.4.24](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.23...unplugin-style-dictionary-v0.4.24) (2026-09-10)


### Dependencies

* update dependency @types/node to v26.5.1 ([#165](https://github.com/kanso-labs/unplugin-style-dictionary/issues/165)) ([7bbac6e](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7bbac6e32e61c810049f9d2c08526f4fc9661bbe))
* update dependency lint-staged to v17.5.1 ([#167](https://github.com/kanso-labs/unplugin-style-dictionary/issues/167)) ([ff6fd68](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ff6fd6805630f2bc8cf109b5012e69fdf3c5d020))
* update dependency vite to v8.3.0 ([#168](https://github.com/kanso-labs/unplugin-style-dictionary/issues/168)) ([8027942](https://github.com/kanso-labs/unplugin-style-dictionary/commit/8027942d12501c3d509be8744c14ff5b3ed2ed4b))
* update kanso-labs/github-actions action to v3.2.2 ([#164](https://github.com/kanso-labs/unplugin-style-dictionary/issues/164)) ([890fc03](https://github.com/kanso-labs/unplugin-style-dictionary/commit/890fc039365106a71f3aefe529560d978c22d526))

## [0.4.23](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.22...unplugin-style-dictionary-v0.4.23) (2026-09-09)


### Dependencies

* update node.js to v24.21.0 ([#161](https://github.com/kanso-labs/unplugin-style-dictionary/issues/161)) ([a8d4008](https://github.com/kanso-labs/unplugin-style-dictionary/commit/a8d40081a2e56bc087c3e14ea022f3fce97ed04c))

## [0.4.22](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.21...unplugin-style-dictionary-v0.4.22) (2026-09-08)


### Dependencies

* update dependency oxfmt to v0.67.0 ([#157](https://github.com/kanso-labs/unplugin-style-dictionary/issues/157)) ([45879e3](https://github.com/kanso-labs/unplugin-style-dictionary/commit/45879e324dbd1013fb3093b0a38e5db6d385e3c2))
* update dependency typescript-eslint to v8.70.0 ([#158](https://github.com/kanso-labs/unplugin-style-dictionary/issues/158)) ([dc64c24](https://github.com/kanso-labs/unplugin-style-dictionary/commit/dc64c240451eb472451b27c90d9a5e4c7c307aa1))
* update oxlint to v1.82.0 ([#159](https://github.com/kanso-labs/unplugin-style-dictionary/issues/159)) ([be05d0c](https://github.com/kanso-labs/unplugin-style-dictionary/commit/be05d0c2522fb01ec1dbe973b65bb06d209201cb))

## [0.4.21](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.20...unplugin-style-dictionary-v0.4.21) (2026-09-07)


### Dependencies

* update dependency @types/node to v26.5.0 ([#155](https://github.com/kanso-labs/unplugin-style-dictionary/issues/155)) ([5d569c8](https://github.com/kanso-labs/unplugin-style-dictionary/commit/5d569c8e2f11ab5bca47176b5d8e9af5b80d0b5f))

## [0.4.20](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.19...unplugin-style-dictionary-v0.4.20) (2026-09-07)


### Dependencies

* update dependency style-dictionary to v5.5.3 ([#153](https://github.com/kanso-labs/unplugin-style-dictionary/issues/153)) ([48f5fa2](https://github.com/kanso-labs/unplugin-style-dictionary/commit/48f5fa20497b0e9b035fb377dd8db5dceef17efa))
* update vitest to v5 ([#147](https://github.com/kanso-labs/unplugin-style-dictionary/issues/147)) ([38cf35a](https://github.com/kanso-labs/unplugin-style-dictionary/commit/38cf35a8291ff42a5e79c34492e7dac449ef8f5f))

## [0.4.19](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.18...unplugin-style-dictionary-v0.4.19) (2026-09-05)


### Dependencies

* update dependency eslint to v10.10.0 ([#150](https://github.com/kanso-labs/unplugin-style-dictionary/issues/150)) ([937b4f1](https://github.com/kanso-labs/unplugin-style-dictionary/commit/937b4f1f462bcd9ffb61b4353ec421645f26db2d))
* update dependency lint-staged to v17.5.0 ([#152](https://github.com/kanso-labs/unplugin-style-dictionary/issues/152)) ([7213272](https://github.com/kanso-labs/unplugin-style-dictionary/commit/72132728c82391ee3cc213c245514f681fd35e2c))

## [0.4.18](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.17...unplugin-style-dictionary-v0.4.18) (2026-09-04)


### Dependencies

* update dependency tsdown to v0.23.0 ([#148](https://github.com/kanso-labs/unplugin-style-dictionary/issues/148)) ([9844be3](https://github.com/kanso-labs/unplugin-style-dictionary/commit/9844be3aa37c5b425988924189e340396d63de51))

## [0.4.17](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.16...unplugin-style-dictionary-v0.4.17) (2026-09-02)


### Dependencies

* update dependency @types/node to v26.4.1 ([#144](https://github.com/kanso-labs/unplugin-style-dictionary/issues/144)) ([286b7f6](https://github.com/kanso-labs/unplugin-style-dictionary/commit/286b7f651c98e38cd1e3851dd0af8835ac5eb1b5))
* update dependency globals to v17.12.0 ([#140](https://github.com/kanso-labs/unplugin-style-dictionary/issues/140)) ([2a12500](https://github.com/kanso-labs/unplugin-style-dictionary/commit/2a12500fc80ea98ab6b509ec00b66ad0b0df5fec))
* update dependency oxfmt to v0.66.0 ([#142](https://github.com/kanso-labs/unplugin-style-dictionary/issues/142)) ([6f138c0](https://github.com/kanso-labs/unplugin-style-dictionary/commit/6f138c0d92af6ec37faad43128b095f8a795bfeb))
* update dependency webpack to v5.110.3 ([#145](https://github.com/kanso-labs/unplugin-style-dictionary/issues/145)) ([17158fc](https://github.com/kanso-labs/unplugin-style-dictionary/commit/17158fc6759af1401b3a7d10a71b7f90cba9135e))
* update oxlint to v1.81.0 ([#143](https://github.com/kanso-labs/unplugin-style-dictionary/issues/143)) ([a22bcf1](https://github.com/kanso-labs/unplugin-style-dictionary/commit/a22bcf1e38f967d03f61ce9cfe8a0c350a720d05))

## [0.4.16](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.15...unplugin-style-dictionary-v0.4.16) (2026-09-01)


### Dependencies

* update dependency typescript-eslint to v8.69.0 ([#138](https://github.com/kanso-labs/unplugin-style-dictionary/issues/138)) ([7b633bc](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7b633bc4b00a52b6d1c173cddea4765996f132a2))

## [0.4.15](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.14...unplugin-style-dictionary-v0.4.15) (2026-08-31)


### Dependencies

* update dependency eslint-plugin-perfectionist to v5.11.0 ([#136](https://github.com/kanso-labs/unplugin-style-dictionary/issues/136)) ([df08ff9](https://github.com/kanso-labs/unplugin-style-dictionary/commit/df08ff9ac3afffee3e64c66d641ad2b9d38319e4))

## [0.4.14](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.13...unplugin-style-dictionary-v0.4.14) (2026-08-30)


### Dependencies

* update dependency webpack to v5.110.2 ([#134](https://github.com/kanso-labs/unplugin-style-dictionary/issues/134)) ([33a27dc](https://github.com/kanso-labs/unplugin-style-dictionary/commit/33a27dc151dbe1f1287c7b1350b31f8cdd98627c))

## [0.4.13](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.12...unplugin-style-dictionary-v0.4.13) (2026-08-28)


### Dependencies

* update dependency rollup to v4.63.1 ([#132](https://github.com/kanso-labs/unplugin-style-dictionary/issues/132)) ([2adf467](https://github.com/kanso-labs/unplugin-style-dictionary/commit/2adf467c780f7093f86c5b0b2f9549b2f4bc8d9c))

## [0.4.12](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.11...unplugin-style-dictionary-v0.4.12) (2026-08-28)


### Dependencies

* update dependency webpack to v5.110.1 ([#131](https://github.com/kanso-labs/unplugin-style-dictionary/issues/131)) ([7ab98d8](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7ab98d8eeb8ca9d99affaf4191382b7a7e7215c1))
* update kanso-labs/github-actions action to v3.2.0 ([#129](https://github.com/kanso-labs/unplugin-style-dictionary/issues/129)) ([b3a6c31](https://github.com/kanso-labs/unplugin-style-dictionary/commit/b3a6c31606c989f8021fdeed0236bb48d9245783))

## [0.4.11](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.10...unplugin-style-dictionary-v0.4.11) (2026-08-27)


### Dependencies

* update dependency lint-staged to v17.4.1 ([#125](https://github.com/kanso-labs/unplugin-style-dictionary/issues/125)) ([7ac004b](https://github.com/kanso-labs/unplugin-style-dictionary/commit/7ac004bce7f7ae70cfccf67297a559a80a31c0b6))
* update dependency webpack to v5.110.0 ([#126](https://github.com/kanso-labs/unplugin-style-dictionary/issues/126)) ([fd597d3](https://github.com/kanso-labs/unplugin-style-dictionary/commit/fd597d3401c58a8b30f6e22aec5f1cef04e4d98e))

## [0.4.10](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.9...unplugin-style-dictionary-v0.4.10) (2026-08-27)


### Dependencies

* update dependency @types/node to v26.4.0 ([#123](https://github.com/kanso-labs/unplugin-style-dictionary/issues/123)) ([e566f56](https://github.com/kanso-labs/unplugin-style-dictionary/commit/e566f5682eec7de0269c7889935c38359a90b91a))

## [0.4.9](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.8...unplugin-style-dictionary-v0.4.9) (2026-08-26)


### Dependencies

* update kanso-labs/github-actions action to v3.1.2 ([#121](https://github.com/kanso-labs/unplugin-style-dictionary/issues/121)) ([8ca4635](https://github.com/kanso-labs/unplugin-style-dictionary/commit/8ca46350416757233fbfe4e06b51d87b784f72eb))

## [0.4.8](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.7...unplugin-style-dictionary-v0.4.8) (2026-08-26)


### Dependencies

* update node.js to v24.20.0 ([#119](https://github.com/kanso-labs/unplugin-style-dictionary/issues/119)) ([53787de](https://github.com/kanso-labs/unplugin-style-dictionary/commit/53787deeb2e61856973e13c5e974675b0b0b1102))

## [0.4.7](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.6...unplugin-style-dictionary-v0.4.7) (2026-08-25)


### Dependencies

* update dependency rollup to v4.63.0 ([#117](https://github.com/kanso-labs/unplugin-style-dictionary/issues/117)) ([73ea16f](https://github.com/kanso-labs/unplugin-style-dictionary/commit/73ea16f891f58462aa206fc55df0e2fc86ebfd1a))

## [0.4.6](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.5...unplugin-style-dictionary-v0.4.6) (2026-08-24)


### Dependencies

* update dependency @types/node to v26.3.0 ([#115](https://github.com/kanso-labs/unplugin-style-dictionary/issues/115)) ([73e6bce](https://github.com/kanso-labs/unplugin-style-dictionary/commit/73e6bcee8a7e57bc5c4340c430c85d8d9ff0f5e8))

## [0.4.5](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.4...unplugin-style-dictionary-v0.4.5) (2026-08-24)


### Dependencies

* update eslint ([#113](https://github.com/kanso-labs/unplugin-style-dictionary/issues/113)) ([df5a1e0](https://github.com/kanso-labs/unplugin-style-dictionary/commit/df5a1e08bf5fa872c2a8066b8c300fce2edce1d9))

## [0.4.4](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.3...unplugin-style-dictionary-v0.4.4) (2026-08-24)


### Dependencies

* update dependency oxlint to v1.80.0 ([#111](https://github.com/kanso-labs/unplugin-style-dictionary/issues/111)) ([b8bed4e](https://github.com/kanso-labs/unplugin-style-dictionary/commit/b8bed4e87150f7d481725d4bb444b99641e98770))

## [0.4.3](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.2...unplugin-style-dictionary-v0.4.3) (2026-08-24)


### Dependencies

* update dependency oxfmt to v0.65.0 ([#109](https://github.com/kanso-labs/unplugin-style-dictionary/issues/109)) ([b95ffdc](https://github.com/kanso-labs/unplugin-style-dictionary/commit/b95ffdc7e58c78ab7f3e2fba797a38e182080311))

## [0.4.2](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.1...unplugin-style-dictionary-v0.4.2) (2026-08-21)


### Dependencies

* update kanso-labs/github-actions action to v3.1.1 ([#105](https://github.com/kanso-labs/unplugin-style-dictionary/issues/105)) ([d92f7cd](https://github.com/kanso-labs/unplugin-style-dictionary/commit/d92f7cd4ca1fd589f166ff52d5b8daec2853a30c))

## [0.4.1](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.4.0...unplugin-style-dictionary-v0.4.1) (2026-08-21)


### Dependencies

* update oxlint to v1.79.0 ([#100](https://github.com/kanso-labs/unplugin-style-dictionary/issues/100)) ([4b914a0](https://github.com/kanso-labs/unplugin-style-dictionary/commit/4b914a0a05cd308684a1d6ec6c9e35661b12576b))

## [0.4.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.3.0...unplugin-style-dictionary-v0.4.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* drop the CommonJS build and ship ESM only ([#93](https://github.com/kanso-labs/unplugin-style-dictionary/issues/93))

### Build System

* drop the CommonJS build and ship ESM only ([#93](https://github.com/kanso-labs/unplugin-style-dictionary/issues/93)) ([64caa41](https://github.com/kanso-labs/unplugin-style-dictionary/commit/64caa41565a42791754b95e462a7a6132908c247))

## [0.3.0](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.6...unplugin-style-dictionary-v0.3.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* replace the Vite library build with tsdown, and Prettier with oxfmt ([#90](https://github.com/kanso-labs/unplugin-style-dictionary/issues/90))

### Build System

* replace the Vite library build with tsdown, and Prettier with oxfmt ([#90](https://github.com/kanso-labs/unplugin-style-dictionary/issues/90)) ([d62fbc4](https://github.com/kanso-labs/unplugin-style-dictionary/commit/d62fbc4439b4bf261fd9c07520a33416e15fcdc7))

## [0.2.6](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.5...unplugin-style-dictionary-v0.2.6) (2026-08-21)


### Dependencies

* update kanso-labs/github-actions action to v3.0.2 ([#87](https://github.com/kanso-labs/unplugin-style-dictionary/issues/87)) ([1a4e5cf](https://github.com/kanso-labs/unplugin-style-dictionary/commit/1a4e5cfe68b0750a9e6ae707ecae4158da6c01ea))

## [0.2.5](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.4...unplugin-style-dictionary-v0.2.5) (2026-08-21)


### Dependencies

* update kanso-labs/github-actions action to v3 ([#85](https://github.com/kanso-labs/unplugin-style-dictionary/issues/85)) ([4753676](https://github.com/kanso-labs/unplugin-style-dictionary/commit/4753676e7c08ba586e19818489b15d476c4fa1cb))

## [0.2.4](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.3...unplugin-style-dictionary-v0.2.4) (2026-08-21)


### Dependencies

* update dependency eslint to v10.9.0 ([#83](https://github.com/kanso-labs/unplugin-style-dictionary/issues/83)) ([ce1eda4](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ce1eda4b94f72bb9f8835530181d87e2877ff48b))

## [0.2.3](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.2...unplugin-style-dictionary-v0.2.3) (2026-08-21)


### Dependencies

* update js-yaml and brace-expansion to patched versions ([#76](https://github.com/kanso-labs/unplugin-style-dictionary/issues/76)) ([633a17a](https://github.com/kanso-labs/unplugin-style-dictionary/commit/633a17a478f327c35878a487ce5697bd3f2dd81d))

## [0.2.2](https://github.com/kanso-labs/unplugin-style-dictionary/compare/unplugin-style-dictionary-v0.2.1...unplugin-style-dictionary-v0.2.2) (2026-08-20)


### Bug Fixes

* write generated files atomically ([#71](https://github.com/kanso-labs/unplugin-style-dictionary/issues/71)) ([ab7886e](https://github.com/kanso-labs/unplugin-style-dictionary/commit/ab7886ee29f9fc2ea6d290ea887db0d67657279a))

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
