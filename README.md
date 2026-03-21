# Agent Helper Kit

Agent Helper Kit is a VS Code extension for developers who want faster AI-assisted workflows inside the editor.

It focuses on two practical jobs:

- Move code review comments into chat with file/line context.
- Provide reliable shell tools for agent workflows that need command status and structured output.

## Features

### Bring review comments to chat

![Copy to Chat](./docs/screens/copy-to-chat.jpg)

Select code comments, e.g. from Copilot Code Review or CodeRabbit, to format and include them in the chat context, with source location context.

By default, each `Copy to Chat` click sends that review comment straight into chat history. If you prefer batching, enable `agent-helper-kit.bringToChat.queueBeforeSend` to enqueue the comments. When ready, call up the chat participant `@bringCommentsToChat` (should be already prefilled) and all enqueued comments are then brought in.

- Command: `Copy to Chat` (`agent-helper-kit.reviewCommentToChat`)
- Chat participant: `@bringCommentsToChat` (`agent-helper-kit.bringCommentsToChat`)

### Agent-friendly shell tools

![sync command](./docs/screens/sync-command.jpg)

Compared with built-in terminal tools, these extension tools are optimized for agent workflows.

**Benefits:**

- Deterministic command lifecycle with stable IDs you can await, poll, and kill.
- Structured metadata (`exitCode`, `terminationSignal`, `timedOut`, `shell`) that is easier to automate against.
- Output controls (`full_output`, `last_lines`, `regex`) to reduce context noise in chat.
- `run_in_sync_shell` is optimal for single- or multi-step deterministic commands.
- `run_in_async_shell` is optimal for long-running detached jobs plus explicit polling.

**Tradeoffs:**

- No interactive terminal session (these are command-execution APIs, not full terminal UIs).
- No state/environment persistence between command runs, each command runs in a fresh shell instance.

**Recommendation:** for development flows where most or all commands are non-interactive and require no environment state persistency, you can disable the built-in terminal tools.

![terminal tools](./docs/screens/terminal-tools.jpg)

## Configuration

- `agent-helper-kit.bringToChat.enabled`: enable or disable bring-to-chat actions.
- `agent-helper-kit.bringToChat.queueBeforeSend`: queue comments and bring-all-to-chat flow instead of immediate send on each click.
- `agent-helper-kit.shellTools.enabled`: enable or disable shell tool registration.
- `agent-helper-kit.shellOutput.inMemoryOutputLimitKiB`: KiB of shell output to keep in memory before immediately spilling to a temp file. Set to `0` to disable the size-based spill threshold.
- `agent-helper-kit.shellOutput.memoryToFileSpillMinutes`: minutes to keep output in memory before spilling to file.
- `agent-helper-kit.shellOutput.startupPurgeMaxAgeHours`: startup cleanup threshold for old persisted output.

## Contributing

- Open a ticket for bug reports, questions, and feature suggestions.
- Pull requests are welcome for fixes and improvements.
- Before opening a PR, run `yarn lint:check` and `yarn test`.

## License

MIT - see [LICENSE](./LICENSE).
