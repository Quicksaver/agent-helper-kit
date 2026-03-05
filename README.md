# Custom VS Code Extension

Personal VS Code extension focused on improving in-editor workflows with chat integrations and language model tools.

## Goals

- Make code-review context available directly inside VS Code chat.
- Expose terminal automation primitives as extension-owned language model tools.
- Keep workflows lightweight and scriptable for agentic usage.

## Features

### 1) Bring review comments to chat

- Command: `custom-vscode.reviewCommentToChat`
- Chat participant: `@bringCommentsToChat` (`custom-vscode.bringCommentsToChat`)
- Purpose: copy review comment content into chat with file/line context.

### 2) Enhanced terminal tools for agents

The extension contributes and registers these language model tools:

- `run_in_sync_shell`
- `run_in_async_shell`
- `await_shell`
- `get_shell_output`
- `kill_shell`
- `shell_last_command`

These are extension-scoped copies of the built-in terminal-style tool APIs.

Run tool behavior:

- `run_in_sync_shell` returns YAML metadata by default (`id`, `exitCode`, `terminationSignal`, `timedOut`) and supports inline output options via `full_output`, `last_lines`, or `regex`.
- `run_in_async_shell` returns YAML with `id` by default.
- `run_in_async_shell` is id-only; use `get_shell_output` for output.

`get_shell_output` returns Markdown frontmatter with `exitCode`, `isRunning`, and `terminationSignal` plus a fenced output block.

## Requirements

- VS Code `^1.109.0`
- Node.js 22+
- Yarn 4+

## Install

### Option A: Install a packaged `.vsix`

If you already have a `.vsix` file:

```bash
code --install-extension custom-vscode-<version>.vsix
```

### Option B: Build and install from source

From the project root:

```bash
yarn install
yarn package:build
yarn package:install
```

This creates a `.vsix` and installs the latest one into your local VS Code.

## Development

Useful commands:

```bash
yarn build
yarn watch
yarn test
yarn lint:check
```

## Output persistence and cleanup

- Output is kept in memory first for each terminal id.
- After a short delay (a few minutes), in-memory output is copied to a per-command file in the system temp directory and then purged from memory.
- The in-memory spill delay is configurable via `custom-vscode.shellOutput.memoryToFileSpillMinutes` (default: 2).
- If a terminal process receives `SIGINT` (for example Ctrl+C), signal handling does not trigger output purging.
- For other termination signals (for example `SIGTERM`/`SIGKILL`):
  - if output is still in memory, it remains there until the normal spill time and is purged then (not written to disk)
  - if output is already on disk, it is purged immediately
- On host startup, persisted output files older than a configurable max age are purged; use `custom-vscode.shellOutput.startupPurgeMaxAgeHours` (default: 6).

## How an agent can test terminal tools integration (after install)

See <docs/integration-checks.md>.

## License

MIT — see [LICENSE](LICENSE).
