# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-03-09

### Changed

- Made the in-memory shell output spill threshold configurable with `agent-helper-kit.shellOutput.inMemoryOutputLimitKiB`, increased the default threshold to 512 KiB, and changed size-based spilling to preserve full output by switching to file-backed storage instead of truncating the oldest output.
- Updated the Shell Runs panel output view to open scrolled to the end by default, keep following new output when already at the end, and preserve the user's scroll position when they have scrolled up.

### Fixed

- Fixed a Shell Runs panel state edge case where an invalid persisted sidebar width could prevent the layout width from restoring cleanly.

## [1.0.0] - 2026-03-06

### Added

- Initial public release of Agent Helper Kit.
