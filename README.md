# Agent Helper Kit

Agent Helper Kit is a VS Code extension for developers who want faster AI-assisted workflows inside the editor.

It focuses on two practical jobs:

- Move code review comments into chat with file/line context.
- Provide reliable shell tools for agent workflows that need command status and structured output.

## Why use it

- Keep review context in one place while you chat and fix code.
- Run shell commands through extension-owned tools with consistent IDs and status tracking.
- Use async and sync flows depending on whether you need background execution or immediate completion.

## Features

### Bring review comments to chat

- Command: `agent-helper-kit.reviewCommentToChat`
- Chat participant: `@bringCommentsToChat` (`agent-helper-kit.bringCommentsToChat`)
- Result: selected review comments are formatted for chat with source location context.

### Agent-friendly shell tools

Contributed tools:

- `run_in_sync_shell`
- `run_in_async_shell`
- `await_shell`
- `get_shell_output`
- `kill_shell`
- `get_shell_command`
- `get_last_shell_command`

`run_in_sync_shell` returns completion metadata and can optionally include output (`full_output`, `last_lines`, or `regex`).

`run_in_async_shell` returns an `id` so you can await completion and retrieve output separately.

## Requirements

- VS Code `^1.109.0`
- Node.js 22+
- Yarn 4+

## Install

### Install from `.vsix`

```bash
code --install-extension agent-helper-kit-<version>.vsix
```

### Build and install locally

```bash
yarn install
yarn package:build
yarn package:install
```

## Configuration

- `agent-helper-kit.bringToChat.enabled`: enable or disable bring-to-chat actions.
- `agent-helper-kit.shellTools.enabled`: enable or disable shell tool registration.
- `agent-helper-kit.shellOutput.memoryToFileSpillMinutes`: minutes to keep output in memory before spilling to file.
- `agent-helper-kit.shellOutput.startupPurgeMaxAgeHours`: startup cleanup threshold for old persisted output.

## Development

```bash
yarn build
yarn watch
yarn lint:check
yarn test
```

For terminal-tool integration checks after install, see `docs/integration-checks.md`.

## Contributing

- Open a ticket for bug reports, questions, and feature suggestions.
- Pull requests are welcome for fixes and improvements.
- Use Node.js 22+ and Yarn 4+, then run `yarn install`.
- Before opening a PR, run `yarn lint:check` and `yarn test`.

## License

MIT - see [LICENSE](LICENSE).
