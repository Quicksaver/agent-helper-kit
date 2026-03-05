# Terminal Integration Checks

Use the VS Code Chat tool-calling flow (or an agent capable of invoking extension LM tools) and run this sequence.

## 1) Run a foreground command

Invoke `run_in_sync_shell` with:

```json
{
  "command": "pwd && echo ready",
  "explanation": "verify foreground execution",
  "goal": "integration smoke test",
  "timeout": 10000
}
```

Expected response format: YAML-only (no output block by default).

Example response:

```yaml
id: 'custom-terminal-...'
exitCode: 0
terminationSignal: null
timedOut: false
```

Then read output by id:

```json
{ "id": "<id-from-step-1>" }
```

via `get_shell_output`, or request inline output directly from `run_in_sync_shell` by passing one of:

```json
{ "full_output": true }
```

```json
{ "last_lines": 20 }
```

```json
{ "regex": "ready|error" }
```

`full_output`, `last_lines`, and `regex` are mutually exclusive for `run_in_sync_shell` input (choose exactly one when requesting inline output).

When using `full_output` in step 1, example output block:

```text
/workspace
ready
```

## 2) Start a background command

Invoke `run_in_async_shell` with:

```json
{
  "command": "for i in 1 2 3; do echo tick-$i; sleep 1; done",
  "explanation": "verify background execution",
  "goal": "capture terminal id",
  "timeout": 0
}
```

Expected response format: YAML-only (id by default), for example:

```yaml
id: 'custom-terminal-...'
```

## 3) Poll output while running

Invoke `get_shell_output`:

```json
{ "id": "<id-from-step-2>" }
```

Expected response format: Markdown with YAML frontmatter and a fenced output block.

Example frontmatter:

```yaml
isRunning: true
```

Example output:

```text
tick-1
```

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
- `get_shell_output` frontmatter includes `exitCode`, `isRunning`, and `terminationSignal` (it does not include `timedOut`).
- `run_in_sync_shell` supports `full_output`, `last_lines`, and `regex`; `run_in_async_shell` always returns only `id`.
- For `run_in_async_shell`, `timeout` applies to shell execution timeout, not to `await_shell` waiting time.

## 3b) Manual long-running check (`isRunning: true` + await behavior)

Start a longer background command:

```json
{
  "command": "for i in 1 2 3 4 5; do echo slow-tick-$i; sleep 2; done",
  "explanation": "manual running-state verification",
  "goal": "verify output polling while still running",
  "timeout": 0
}
```

Immediately call `get_shell_output` with that new id:

```json
{ "id": "<id-from-long-running-command>" }
```

Expected (if called quickly): frontmatter includes `isRunning: true` and output is partial (for example, only first tick(s)).

Then call `await_shell` with:

```json
{ "id": "<id-from-long-running-command>", "timeout": 0 }
```

Expected: markdown+frontmatter with `timedOut: false` and output containing terminal completion details.

## 4) Wait for completion

Invoke `await_shell`:

```json
{ "id": "<id-from-step-2>", "timeout": 5000 }
```

Expected: markdown+frontmatter result with `exitCode`/`timedOut` in frontmatter and captured text in the fenced output block.

## 5) Verify last command tracking

Invoke `shell_last_command` with `{}`.

Expected response format: YAML-only with `command`, which equals the last command passed to `run_in_sync_shell` or `run_in_async_shell`.

To query a specific background terminal instead, pass an optional `id`:

```json
{ "id": "<id-from-step-2>" }
```

Expected: YAML-only `command` equals the command used to create that terminal id.

## 6) Verify kill behavior (optional)

Start a long-running background command (e.g. `sleep 30`), then call:

```json
{ "id": "<id>" }
```

via `kill_shell`.

Expected response format: YAML-only, for example:

```yaml
killed: true
```

A subsequent `await_shell` eventually reports completion in markdown+frontmatter format.
