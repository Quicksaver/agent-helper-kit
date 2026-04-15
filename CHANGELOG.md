# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2026-04-15

### Fixed

- Fixed shell tools showing long agent-facing descriptions in VS Code user-facing tool lists, which made them harder to scan; they now use short user descriptions instead.

## [1.3.0] - 2026-04-13

### Added

- Added shell tool approval prompts for commands that are not explicitly allowed, so model-triggered shell runs no longer execute unchecked by default.
- Added configurable shell approval rules (`allow`, `ask`, `deny`), optional model-based risk assessment, and a model picker command so trusted command patterns can skip repeated prompts without disabling review entirely.
- Added `send_to_shell` so a running `run_in_shell` command can receive one piped stdin reply at a time, including an empty line to simulate pressing Enter.

### Changed

- Consolidated `run_in_sync_shell` and `run_in_async_shell` into `run_in_shell`. Callers should now omit `timeout` for the old async-start behavior or provide `timeout` for the old sync-wait behavior.

### Fixed

- Fixed `run_in_shell` Git commands that could hang by handing control to a pager, editor, or terminal credential prompt instead of returning a result to the tool.

## [1.2.2] - 2026-03-23

### Fixed

- Fixed `run_in_sync_shell` tool metadata that did not mark `timeout` as required, which could advertise an input shape that the implementation would reject.

## [1.2.1] - 2026-03-21

### Fixed

- Fixed shell-tool runs that could make Node CLI tables, appear clamped to 80 columns and truncate long rows even when more width was available.
- Fixed a Shell Runs panel bug where selecting a command or taking actions in the panel could reset the command output scroll position back to the top.

## [1.2.0] - 2026-03-10

### Added

- Added a dedicated `Agent Helper Kit` output channel so extension diagnostics no longer disappear into the generic Extension Host log.
- Added optional `cwd` input support to `run_in_async_shell` and `run_in_sync_shell`, with validation that rejects missing, inaccessible, or non-directory paths before launch.

### Changed

- Reworked the Shell Runs details layout so selected-run metadata is shown inline in the panel instead of behind a hover tooltip, making command context easier to scan and copy.
- Removed blank and whitespace-only lines from captured shell output after control-sequence stripping so `get_shell_output`, `run_in_sync_shell`, and the Shell Runs panel no longer surface spacer-only lines.

### Fixed

- Fixed a Shell Runs panel bug where commands whose output had already spilled to disk could still show metadata but an empty output pane when selected.
- Fixed shell runs that could remain stuck in a running state after their shell process had already exited, which prevented `run_in_async_shell` and `run_in_sync_shell` from returning final output and exit status for some commands.
- Tightened Shell Runs panel kill handling to report termination more accurately.
- Fixed Shell Runs panel polling to update only the output block when new output arrives.
- Fixed Shell Runs color capture for pipe-based commands by defaulting shell executions to color-capable environment variables while still respecting explicit `NO_COLOR` settings.
- Fixed a Shell Runs reload issue where the panel could reopen with `(command not recorded)` entries or show stale runs from other workspaces; it now starts empty and only lists runs started in the current session.

## [1.1.0] - 2026-03-09

### Changed

- Made the in-memory shell output spill threshold configurable with `agent-helper-kit.shellOutput.inMemoryOutputLimitKiB`, increased the default threshold to 512 KiB.
- Changed size-based spilling to preserve full output by switching to file-backed storage instead of truncating the oldest output.
- Updated the Shell Runs panel output view to open scrolled to the end by default, keep following new output when already at the end, and preserve the user's scroll position when they have scrolled up.

### Fixed

- Fixed a Shell Runs panel state edge case where an invalid persisted sidebar width could prevent the layout width from restoring cleanly.

## [1.0.0] - 2026-03-06

### Added

- Initial public release of Agent Helper Kit.
