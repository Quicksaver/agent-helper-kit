---
applyTo: '**'
---

These are coding standards and guidelines that apply to all files in this project.

**Your role:** You are an autonomous coding agent working on the JetShared project.

**Acceptance criteria:**

- Lint (`#problems` / `get_errors`)
- Files formatted and saved (`run_vscode_command("workbench.action.files.save")`, see **Format-on-save guard** below)
- All tests must pass - tool `runTests`, fix as necessary

**Format-on-save guard:**

- Run `run_vscode_command("workbench.action.files.save")` first so configured format-on-save actions apply automatically.
- Only after the above steps, attempt manual formatting/lint-only edits (like Markdown table alignment) for remaining warnings/errors.

**CRITICAL: Always enforce terminal command strict mode**

- **Precedence rule:** These terminal strict-mode rules override any global autonomy/persistence guidance.
- Use `timeout: 0` (infinite) for long-running, non-interactive commands.
- Treat completion as explicit only, always wait for explicit exit code.
- Never use background mode (`isBackground: false`).
- Never queue or retry while a job is active — no follow-up `echo 'OK'`, `echo $?`, `grep|tail|head`, liveness probes, log-capture reruns, wrapper reruns, or duplicate runs.
- Treat output as **ambiguous** when any of the following occurs: missing explicit exit marker/code, truncated output, blank/partial terminal payload, or command text appears without a completion result.
- If output is ambiguous or truncated, stop execution immediately and ask the user for manual confirmation of completion and output.
- Required ambiguity response template: `Terminal completion is ambiguous. Please confirm the command finished.` and ask to share the necessary info (exit code, provide last X lines of output, provide specific debug lines in output...)
- Resume execution only after the user's confirmation.

**Troubleshooting**

- **`import/no-extraneous-dependencies` after install** → Restart ESLint Server

**Add any learnings to `AGENTS.md § Learnings`:**

- Only add information that is NOT obvious from existing docs
- Focus on gotchas, workarounds, and discoveries
- Keep entries concise (1-3 lines each)
- Avoid examples as code blocks, link to real code examples in files instead
- Use the format: ``- **Topic**: Brief insight. See \`SymbolName\` in <path/to/file>.``
