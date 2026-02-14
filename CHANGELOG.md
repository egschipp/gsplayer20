# Changelog

## [1.3.0](https://github.com/egschipp/gsplayer20/compare/v1.2.0...v1.3.0) (2026-02-14)


### Features

* add discover suggestions and Spotify-like controls ([3a468b2](https://github.com/egschipp/gsplayer20/commit/3a468b27e2d0ab5e6710d3304ddc12055d13685b))
* add editable ChatGPT prompt and fix shuffle mapping ([399fde6](https://github.com/egschipp/gsplayer20/commit/399fde63faef7dadb9f3b000de860c2231a79338))
* add mute toggle with visible state ([7306d93](https://github.com/egschipp/gsplayer20/commit/7306d93bc65c145deae3a87637de9e64bc157b6b))
* add track metadata to ChatGPT prompt ([938d752](https://github.com/egschipp/gsplayer20/commit/938d7520940d9f73ec77a5f04d535ec1c0b01fb3))
* default connect to GSPlayer20 Web ([3b320cc](https://github.com/egschipp/gsplayer20/commit/3b320cc7418ef81b6f25381caa2424d877c515d2))
* extend player features and chatgpt prompt tokens ([b7a7923](https://github.com/egschipp/gsplayer20/commit/b7a79233a9a5ffdefe7a6e8ce95ca44ce1a29aa2))
* fetch track meta for ChatGPT prompt ([65b0581](https://github.com/egschipp/gsplayer20/commit/65b0581c686a930e9c56c6d067da4ad10498b948))
* harden playback flow and context play ([e1fe946](https://github.com/egschipp/gsplayer20/commit/e1fe9462000df0dd6b2449613bf4002955fa391e))
* implement review recommendations ([40ada58](https://github.com/egschipp/gsplayer20/commit/40ada58cc48215d22da6fa969014b0512fb227eb))
* improve playback sync, UI, and pin login ([f344cf6](https://github.com/egschipp/gsplayer20/commit/f344cf66870dce2e18da5582be3ca40e344666e3))
* improve player responsiveness and controls ([4eda1b2](https://github.com/egschipp/gsplayer20/commit/4eda1b28bb471206b1454e5b93a441d99ccd30f4))
* improve player responsiveness and device refresh ([01bacf8](https://github.com/egschipp/gsplayer20/commit/01bacf85fe589ae8f099ebab7139fbea643ebe2d))
* limit player to gsplayer page ([3870350](https://github.com/egschipp/gsplayer20/commit/3870350cd34d3a8d726a9c0c3cb58eed5b051217))
* make player controls interactive divs ([d1895f1](https://github.com/egschipp/gsplayer20/commit/d1895f10f626cd56432d670807c0891f178748bc))
* make spotify connect selection robust ([83f3daf](https://github.com/egschipp/gsplayer20/commit/83f3daf2dfc363b540177dc4d7be7b4b2e3cb6ce))
* match player control gradients ([4077923](https://github.com/egschipp/gsplayer20/commit/40779230cc4f2523e140010515e88096a1eb3ba4))
* move progress slider to player area ([44c37d2](https://github.com/egschipp/gsplayer20/commit/44c37d2c5468083e713bb3ce6e34c58ba6d2a1bd))
* persist player and tidy account actions ([9015f0b](https://github.com/egschipp/gsplayer20/commit/9015f0bc0a29cd554b193b748830ec867d00b331))
* refine account layout and nav label ([7d0c22a](https://github.com/egschipp/gsplayer20/commit/7d0c22a4d3f269f1d3f889d4aceeef872e9f0213))
* refine account page UX ([97470c9](https://github.com/egschipp/gsplayer20/commit/97470c943fafdc5cf68fd527f5d40bb814c3d920))
* rename account to settings and filter prompt playlists ([aded60c](https://github.com/egschipp/gsplayer20/commit/aded60c0c9be269badd78b7420ebd2c86a8d8807))
* reorder account layout and spotify info ([e3ca988](https://github.com/egschipp/gsplayer20/commit/e3ca988a4a58da0a62cccf26f884884b08c7da6a))
* restore liked songs and slider fill ([5409b5e](https://github.com/egschipp/gsplayer20/commit/5409b5eacca5c4505047d1f51b14593523e228e9))
* show spotify account details ([311b110](https://github.com/egschipp/gsplayer20/commit/311b110aa426195d2c59faa588dfd6147e45fa98))
* stabilize player and improve data handling ([f87cdad](https://github.com/egschipp/gsplayer20/commit/f87cdad2ad1ab8c5668fc742716862866d580ceb))
* style account buttons with green outline ([c56e978](https://github.com/egschipp/gsplayer20/commit/c56e978b27ea9bea9afcb3f5982fc5aa09d3ce70))
* update account actions and bump version ([02d7620](https://github.com/egschipp/gsplayer20/commit/02d76200fe7b550f476daced072d2d30f0a7ec2b))


### Bug Fixes

* allow auth routes in middleware ([2776767](https://github.com/egschipp/gsplayer20/commit/27767670704be4e31d4e7b70f2cd49090b1c58da))
* clean existing containers before deploy ([35813bb](https://github.com/egschipp/gsplayer20/commit/35813bb89d990fd3e0da03173f2e3a1eead695c2))
* clean status page and reset track start ([08bceec](https://github.com/egschipp/gsplayer20/commit/08bceec5d98d9e6153ffc9d913a82378648f2e9d))
* default NEXTAUTH_URL from AUTH_URL ([fd2031a](https://github.com/egschipp/gsplayer20/commit/fd2031addac7d91ab6a6bcff19d448ddd0cf92e4))
* enforce compose v2 in deploy ([74ab1e1](https://github.com/egschipp/gsplayer20/commit/74ab1e123e6dde7d55b4da052a5ce9fa2204768a))
* enforce shuffle state on play ([70159de](https://github.com/egschipp/gsplayer20/commit/70159dec91b2d6f8a5c336632fed0ad8a7ddf3be))
* force shuffle off for explicit track selection ([ad58ae3](https://github.com/egschipp/gsplayer20/commit/ad58ae357297060edf60f1d4a466b2e01a6f261a))
* guard nextauth env and log handler errors ([22a2e88](https://github.com/egschipp/gsplayer20/commit/22a2e88ef2029445b42f772466de97fefcb37eb9))
* guard track id selection for play ([804cc36](https://github.com/egschipp/gsplayer20/commit/804cc36b24252cc824a57a05546e1ac5fad62db8))
* improve player responsiveness ([a387caa](https://github.com/egschipp/gsplayer20/commit/a387caa70135fc5e348033dfff208289ed2ee1ce))
* keep player synced with spotify connect ([4948312](https://github.com/egschipp/gsplayer20/commit/49483126fbe9e03e066de3d71ee2f7649150126c))
* load full lists and track selection by id ([4aa3652](https://github.com/egschipp/gsplayer20/commit/4aa36520a0c40d227e2cec5b0c90d9c4d7cacc26))
* make now playing highlight consistent ([ce8771a](https://github.com/egschipp/gsplayer20/commit/ce8771a40b474a8698dd9b36b343dcd01c4160f1))
* normalize track album payload ([22c0792](https://github.com/egschipp/gsplayer20/commit/22c079280c51b66cc319e5965da740e0dd31517c))
* normalize track artists in list ([b5a6195](https://github.com/egschipp/gsplayer20/commit/b5a619508104bb561f0f12ae3d34c3f0e97fec47))
* paginate playlists in order and remove load more ([9942518](https://github.com/egschipp/gsplayer20/commit/9942518505c7cf8ee17ad04e783d03e28fef495f))
* pass nextauth route params to handler ([bad4098](https://github.com/egschipp/gsplayer20/commit/bad4098e49e259bbeaecb372eddb68b2be728c37))
* prevent default artist selection ([6eb71b2](https://github.com/egschipp/gsplayer20/commit/6eb71b2210178bf5a4fe1165ba8c6984c8ae8fee))
* refresh devices handler ([75287ec](https://github.com/egschipp/gsplayer20/commit/75287ecdcd3cbe4249438762bc6cb75ffad71fe6))
* remove duplicate ChatGPT prompt import ([5de0d85](https://github.com/egschipp/gsplayer20/commit/5de0d85f8466d32f377ef760e50fc90f40f11f4a))
* remove duplicate playlist empty state ([327e7b9](https://github.com/egschipp/gsplayer20/commit/327e7b9913086c8a5a18c999ec0def78bebde1a8))
* remove sync cooldown references ([cf7ab3d](https://github.com/egschipp/gsplayer20/commit/cf7ab3dc9f2f29d235a6fa1c97a9b5a5a88d8e41))
* restore ChatGPT prompt imports ([99363af](https://github.com/egschipp/gsplayer20/commit/99363afe8622bfeac091ef3b026d784b542265df))
* run build on self-hosted ARM64 runner ([58ccf18](https://github.com/egschipp/gsplayer20/commit/58ccf183accd5962e1c4980431e1e61f45a3f8a8))
* stabilize player queue and liked songs playback ([ff4043c](https://github.com/egschipp/gsplayer20/commit/ff4043c749ac85285671d4ee0eae1b2dd5f11b2c))
* suppress auth error during playback ([692d0c7](https://github.com/egschipp/gsplayer20/commit/692d0c73ce44729983a3122cf4b9e9c9095f1afe))
* surface spotify auth errors for suggestions ([c645580](https://github.com/egschipp/gsplayer20/commit/c645580bc31b189318d5eca07bf7ababff940036))
* type annotations in discover route ([19adf86](https://github.com/egschipp/gsplayer20/commit/19adf868b83b5f94746aa5d4d7b8e6bd9ca89faa))
* type spotify batch artist response ([c55302e](https://github.com/egschipp/gsplayer20/commit/c55302e026f002f133e617c548e8b65f45637d01))
* unblock build errors and metadata ([a2af0c7](https://github.com/egschipp/gsplayer20/commit/a2af0c7734578a9e226ffc25b60f1ca8cee35e46))
* use docker compose v2 on deploy ([94cf77b](https://github.com/egschipp/gsplayer20/commit/94cf77b039d869e11cb78807caf8b307ffbc0311))

## [1.2.0](https://github.com/egschipp/gsplayer20/compare/v1.1.1...v1.2.0) (2026-02-06)


### Features

* library selector + collapsible resources ([57246d7](https://github.com/egschipp/gsplayer20/commit/57246d756ce7a66e1db901fe35d32e3608067d57))
* playlists/artists/tracks selector ([47f5e77](https://github.com/egschipp/gsplayer20/commit/47f5e77c1e7e24feaff779f21a81288e733d96b3))
* stabilize ARM64 builds and player performance ([d051697](https://github.com/egschipp/gsplayer20/commit/d051697ce4730eb527989c4f04c7f5ff86df5a6d))
* track selector covers + reset ([0889d5f](https://github.com/egschipp/gsplayer20/commit/0889d5f145ada942bce25610448e960ff18358d8))


### Bug Fixes

* close selector on choose ([86a6edb](https://github.com/egschipp/gsplayer20/commit/86a6edb7f0945065e77f855cf32ad3bd98ac407f))
* dedupe tracks by name + artist lookup ([39c458d](https://github.com/egschipp/gsplayer20/commit/39c458db68aedaa0282cfc9c86f5e67167243d8a))
* null guard in playlist loader ([85b3cc1](https://github.com/egschipp/gsplayer20/commit/85b3cc119ccd7872bc0d0c4fa0e945431a45ba50))
* track covers and selector focus ([ba091cd](https://github.com/egschipp/gsplayer20/commit/ba091cd6e1b1d2a59995b832ff6874c08da90287))
* track selector typing for covers ([2e37dd8](https://github.com/egschipp/gsplayer20/commit/2e37dd85b23942551b51bd44b730c01b34cf534d))

## [1.1.1](https://github.com/egschipp/gsplayer20/compare/v1.1.0...v1.1.1) (2026-02-03)


### Bug Fixes

* runner label arm64 -&gt; ARM64 ([1965750](https://github.com/egschipp/gsplayer20/commit/19657502dc07c4dc51024d430be7cb5bb74e2653))
* typings for playlist options ([c68f88d](https://github.com/egschipp/gsplayer20/commit/c68f88d6d73512258eb00a3fa18e75e4d5d57118))

## [1.1.0](https://github.com/egschipp/gsplayer20/compare/v1.0.0...v1.1.0) (2026-02-03)


### Features

* playlist search + sort ([fd2dd10](https://github.com/egschipp/gsplayer20/commit/fd2dd10aa0117745b422bbdd97efd8c4b052b6e1))


### Bug Fixes

* double login ([92c59b3](https://github.com/egschipp/gsplayer20/commit/92c59b3aac0e6b7b9e5bfd0e1efb18c5b69ccf18))
* login/logout, load playlist ([b0c28f1](https://github.com/egschipp/gsplayer20/commit/b0c28f1bdcf7bf1bcce6762607c1aa95df62bb88))
* release-please workflow config ([60851c3](https://github.com/egschipp/gsplayer20/commit/60851c323d32c288c1faab0235e28af6e2e27767))

## 1.0.0 (2026-02-03)


### Bug Fixes

* playlists view, merge sync, 10 min sync ([338dac9](https://github.com/egschipp/gsplayer20/commit/338dac96071aebc88f7c59c44d1b8188ade0e02a))
* release versienummer ([1549f51](https://github.com/egschipp/gsplayer20/commit/1549f515ef46cd31b4d02c66da8b6fe576d32184))
