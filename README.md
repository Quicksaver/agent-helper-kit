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

### 2) Custom terminal tools for agents

The extension contributes and registers these language model tools:

- `custom_run_in_terminal`
- `custom_await_terminal`
- `custom_get_terminal_output`
- `custom_kill_terminal`
- `custom_terminal_last_command`

These are extension-scoped copies of the built-in terminal-style tool APIs.

### 3) MCP server provided by this extension

The extension also publishes a local MCP server definition (`Custom Terminal Tools MCP`) through VS Code's MCP provider API.

This server exposes the same tool names:

- `custom_run_in_terminal`
- `custom_await_terminal`
- `custom_get_terminal_output`
- `custom_kill_terminal`
- `custom_terminal_last_command`

This is intended as a bridge path for agent runtimes that can call MCP tools but do not directly call extension `languageModelTools`.

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

## Enable the extension MCP server in Chat

After installing/reloading the extension:

1. Open Chat tool settings.
2. Find the MCP server provider entry labeled `Custom Terminal Tools MCP`.
3. Enable/connect that server.
4. Confirm the `custom_*` tools appear in the tools list.

## Output persistence and cleanup

- Output is kept in memory first for each terminal id.
- After a short delay (a few minutes), in-memory output is copied to a per-command file in the system temp directory and then purged from memory.
- If a terminal process is terminated by signal (for example `SIGTERM`/`SIGKILL`), output is purged immediately from whichever storage layer currently holds it (memory or temp file).
- On host startup, temp output files that do not correspond to active terminal ids are purged.

## How an agent can test terminal tools integration (after install)

See <docs/integration-checks.md>.
