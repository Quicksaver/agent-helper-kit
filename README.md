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

## How an agent can test terminal tools integration (after install)

Use the VS Code Chat tool-calling flow (or an agent capable of invoking extension LM tools) and run this sequence.

### 1) Run a foreground command

Invoke `custom_run_in_terminal` with:

```json
{
  "command": "pwd && echo ready",
  "explanation": "verify foreground execution",
  "goal": "integration smoke test",
  "isBackground": false,
  "timeout": 10000
}
```

Expected: result contains `output`, `exitCode`, `signal`, and `timedOut`.

### 2) Start a background command

Invoke `custom_run_in_terminal` with:

```json
{
  "command": "for i in 1 2 3; do echo tick-$i; sleep 1; done",
  "explanation": "verify background execution",
  "goal": "capture terminal id",
  "isBackground": true,
  "timeout": 0
}
```

Expected: result includes an `id` like `custom-terminal-...`.

### 3) Poll output while running

Invoke `custom_get_terminal_output`:

```json
{ "id": "<id-from-step-2>" }
```

Expected: `isRunning` boolean and partial/complete `output`.

Optional output filters:

```json
{ "id": "<id-from-step-2>", "last_lines": 20 }
```

```json
{ "id": "<id-from-step-2>", "regex": "error|warning" }
```

Notes:

- `last_lines` and `regex` are mutually exclusive.
- If neither is supplied, all available output is returned.

### 3b) Manual long-running check (`isRunning: true` + await behavior)

Start a longer background command:

```json
{
  "command": "for i in 1 2 3 4 5; do echo slow-tick-$i; sleep 2; done",
  "explanation": "manual running-state verification",
  "goal": "verify output polling while still running",
  "isBackground": true,
  "timeout": 0
}
```

Immediately call `custom_get_terminal_output` with that new id:

```json
{ "id": "<id-from-long-running-command>" }
```

Expected (if called quickly): `isRunning: true` and partial output (for example, only the first tick(s)).

Then call `custom_await_terminal` with:

```json
{ "id": "<id-from-long-running-command>", "timeout": 0 }
```

Expected: this waits until all ticks complete and then returns final status with `timedOut: false` and terminal completion details.

### 4) Wait for completion

Invoke `custom_await_terminal`:

```json
{ "id": "<id-from-step-2>", "timeout": 5000 }
```

Expected: either completed status with `exitCode`/`output`, or `timedOut: true`.

### 5) Verify last command tracking

Invoke `custom_terminal_last_command` with `{}`.

Expected: `command` equals the last command passed to `custom_run_in_terminal`.

To query a specific background terminal instead, pass an optional `id`:

```json
{ "id": "<id-from-step-2>" }
```

Expected: `command` equals the command used to create that terminal id.

### 6) Verify kill behavior (optional)

Start a long-running background command (e.g. `sleep 30`), then call:

```json
{ "id": "<id>" }
```

via `custom_kill_terminal`.

Expected: `{ "killed": true }`, and a subsequent `custom_await_terminal` eventually reports completion.

## Enable the extension MCP server in Chat

After installing/reloading the extension:

1. Open Chat tool settings.
2. Find the MCP server provider entry labeled `Custom Terminal Tools MCP`.
3. Enable/connect that server.
4. Confirm the `custom_*` tools appear in the tools list.

## Output persistence and cleanup

- Output from each terminal command is written to a per-command file in the system temp directory.
- In-memory terminal state is purged after a short retention window (a few minutes) after command completion.
- On host startup, temp output files that do not correspond to active terminal ids are purged.
