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

- `run_in_sync_terminal`
- `run_in_async_terminal`
- `await_terminal_enhanced`
- `get_terminal_output_enhanced`
- `kill_terminal_enhanced`
- `terminal_last_command_enhanced`

These are extension-scoped copies of the built-in terminal-style tool APIs.

Run tool behavior:

- `run_in_sync_terminal` returns YAML metadata by default: `id`, `exitCode`, `terminationSignal`, `timedOut`.
- `run_in_async_terminal` returns YAML with `id` by default.
- `run_in_sync_terminal` supports output options via `full_output`, `last_lines`, or `regex`.
- `run_in_async_terminal` is id-only; use `get_terminal_output_enhanced` for output.

`get_terminal_output_enhanced` returns Markdown frontmatter with `exitCode`, `isRunning`, and `terminationSignal` plus a fenced output block.

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
- If a terminal process receives `SIGINT` (for example Ctrl+C), signal handling does not trigger output purging.
- For other termination signals (for example `SIGTERM`/`SIGKILL`):
  - if output is still in memory, it remains there until the normal spill time and is purged then (not written to disk)
  - if output is already on disk, it is purged immediately
- On host startup, output-store initialization does not purge when there are zero known active terminal ids (to avoid deleting files owned by other concurrent extension-host processes).

## How an agent can test terminal tools integration (after install)

See <docs/integration-checks.md>.
