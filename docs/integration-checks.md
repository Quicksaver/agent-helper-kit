# Terminal Integration Checks

Use the VS Code Chat tool-calling flow (or an agent capable of invoking extension LM tools) and run this sequence.

## 1) Run a foreground command

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

Expected response format: markdown with YAML frontmatter and a fenced text output block.

Example frontmatter:

```yaml
exitCode: 0
signal: null
timedOut: false
```

Example output block:

```text
/workspace
ready
```

## 2) Start a background command

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

Expected response format: YAML-only, for example:

```yaml
id: 'custom-terminal-...'
```

## 3) Poll output while running

Invoke `custom_get_terminal_output`:

```json
{ "id": "<id-from-step-2>" }
```

Expected response format: markdown with YAML frontmatter and a fenced output block.

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

## 3b) Manual long-running check (`isRunning: true` + await behavior)

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

Expected (if called quickly): frontmatter includes `isRunning: true` and output is partial (for example, only first tick(s)).

Then call `custom_await_terminal` with:

```json
{ "id": "<id-from-long-running-command>", "timeout": 0 }
```

Expected: markdown+frontmatter with `timedOut: false` and output containing terminal completion details.

## 4) Wait for completion

Invoke `custom_await_terminal`:

```json
{ "id": "<id-from-step-2>", "timeout": 5000 }
```

Expected: markdown+frontmatter result with `exitCode`/`timedOut` in frontmatter and captured text in the fenced output block.

## 5) Verify last command tracking

Invoke `custom_terminal_last_command` with `{}`.

Expected response format: YAML-only with `command`, which equals the last command passed to `custom_run_in_terminal`.

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

via `custom_kill_terminal`.

Expected response format: YAML-only, for example:

```yaml
killed: true
```

A subsequent `custom_await_terminal` eventually reports completion in markdown+frontmatter format.
