# Changelog

Every release of herdr-channels, newest first. Each one is a GitHub Release too: https://github.com/bensoutendijk/herdr-channels/releases

## [1.8.1](https://github.com/bensoutendijk/herdr-channels/compare/v1.8.0...v1.8.1) (2026-11-23)

### Bug Fixes

* A question card can always be dismissed, and goes by itself after two days ([#49](https://github.com/bensoutendijk/herdr-channels/issues/49)) ([ce27011](https://github.com/bensoutendijk/herdr-channels/commit/ce27011f5c3efe095fc98f610781a9a4b4ddffdc))

## [1.8.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.7.1...v1.8.0) (2026-11-23)

### Features

* Codex tasks: start a task on Codex, answer its approvals from a card, and follow it like any other ([#48](https://github.com/bensoutendijk/herdr-channels/issues/48)) ([39e7f6f](https://github.com/bensoutendijk/herdr-channels/commit/39e7f6fc96ae144410adcef561358932ff566878))

## [1.7.1](https://github.com/bensoutendijk/herdr-channels/compare/v1.7.0...v1.7.1) (2026-11-22)

### Bug Fixes

* Tasks go through a harness layer, ready for Codex, with no change in how they work ([#45](https://github.com/bensoutendijk/herdr-channels/issues/45)) ([6eebefb](https://github.com/bensoutendijk/herdr-channels/commit/6eebefb6dc5774cf7f578974b59148417a7da9b3))

## [1.7.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.6.0...v1.7.0) (2026-11-22)

### Features

* Routines say where they stand: a status in plain words, why a run waits, a stale timer, and a run id in each message ([#44](https://github.com/bensoutendijk/herdr-channels/issues/44)) ([47dc745](https://github.com/bensoutendijk/herdr-channels/commit/47dc74526231669da63fd93cc369fc1475f47763))

## [1.6.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.5.0...v1.6.0) (2026-11-22)

### Features

* A task that ends asking for something tells the chat right away, as a one-line notice ([#43](https://github.com/bensoutendijk/herdr-channels/issues/43)) ([bb50c36](https://github.com/bensoutendijk/herdr-channels/commit/bb50c3654478154c9549dd6317a6488f73961f8f))

## [1.5.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.4.1...v1.5.0) (2026-11-22)

### Features

* Routines a chat answers with the outcome first, sets up with a confirmation, and can propose with --dry-run ([#40](https://github.com/bensoutendijk/herdr-channels/issues/40)) ([2d76503](https://github.com/bensoutendijk/herdr-channels/commit/2d76503b15be423b9f386287c1cdb41c3691edb0))

## [1.4.1](https://github.com/bensoutendijk/herdr-channels/compare/v1.4.0...v1.4.1) (2026-11-22)

### Bug Fixes

* A routine's row no longer shows an old skipped run beside a newer run ([#38](https://github.com/bensoutendijk/herdr-channels/issues/38)) ([49fbc33](https://github.com/bensoutendijk/herdr-channels/commit/49fbc3305dcdc66639e6b6d69353cbba535dd665))

## [1.4.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.3.0...v1.4.0) (2026-11-22)

### Features

* Routines that teach by example, read in plain words, and can run only by hand ([#36](https://github.com/bensoutendijk/herdr-channels/issues/36)) ([2e24227](https://github.com/bensoutendijk/herdr-channels/commit/2e242271959e2b5bba0615b2aa136a25291288cd))

## [1.3.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.2.0...v1.3.0) (2026-11-22)

### Features

* One routine engine for both backends, and Run now that says when the chat has it ([#35](https://github.com/bensoutendijk/herdr-channels/issues/35)) ([122ad11](https://github.com/bensoutendijk/herdr-channels/commit/122ad11873f03c8047ad8588981c771693f0ec15))

## [1.2.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.1.1...v1.2.0) (2026-11-22)

### Features

* Routines, task renaming and third-machine status for a store on another machine ([#34](https://github.com/bensoutendijk/herdr-channels/issues/34)) ([b6b0df6](https://github.com/bensoutendijk/herdr-channels/commit/b6b0df6f76234f9f56f8f2c204a0060c237ff8b6))

## [1.1.1](https://github.com/bensoutendijk/herdr-channels/compare/v1.1.0...v1.1.1) (2026-11-22)

### Bug Fixes

* a Refresh waits out a chat listener's own refresh instead of answering busy ([#33](https://github.com/bensoutendijk/herdr-channels/issues/33)) ([cb4f730](https://github.com/bensoutendijk/herdr-channels/commit/cb4f73097495b6e412a28377e498c350cd414d45))

## [1.1.0](https://github.com/bensoutendijk/herdr-channels/compare/v1.0.2...v1.1.0) (2026-11-21)

### Features

* Update, Refresh and unread dots for a store on another machine, and its chat in the background ([#32](https://github.com/bensoutendijk/herdr-channels/issues/32)) ([c599376](https://github.com/bensoutendijk/herdr-channels/commit/c5993762f9f79dcf2ddb6ec4875891bb3719d625))

## [1.0.2](https://github.com/bensoutendijk/herdr-channels/compare/v1.0.1...v1.0.2) (2026-11-21)

### Bug Fixes

* keep the footer's status dot round when the host name is long ([#31](https://github.com/bensoutendijk/herdr-channels/issues/31)) ([d10d360](https://github.com/bensoutendijk/herdr-channels/commit/d10d36047694fa84d5cb55e51365b33c3abe3d8b))

## [1.0.1](https://github.com/bensoutendijk/herdr-channels/compare/v1.0.0...v1.0.1) (2026-11-20)

### Bug Fixes

* An update refusal fits the sidebar's release row ([#30](https://github.com/bensoutendijk/herdr-channels/issues/30)) ([7c9d70d](https://github.com/bensoutendijk/herdr-channels/commit/7c9d70d9c41e779909c282c1bbc13df7763db506))

## 1.0.0 (2026-11-20)

### Features

* Releases on GitHub, and one-click updates from the sidebar ([#29](https://github.com/bensoutendijk/herdr-channels/issues/29)) ([32b395a](https://github.com/bensoutendijk/herdr-channels/commit/32b395a0a435e022b2189c372e6214a2fc96f7de))
