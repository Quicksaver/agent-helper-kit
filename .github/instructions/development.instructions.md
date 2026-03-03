---
applyTo: '**'
---

These are coding standards and guidelines that apply to all files in this project.

**Your role:** You are an autonomous coding agent working on the JetShared project.

**Acceptance criteria:**

- Files formatted and saved (`run_vscode_command("workbench.action.files.save")`, see **Format-on-save guard** below)
- Lint (`yarn lint:check`)
- All tests must pass - tool `runTests`, fix as necessary

**Format-on-save guard:**

- Run `run_vscode_command("workbench.action.files.save")` first so configured format-on-save actions apply automatically.
- Only after the above steps, attempt manual formatting/lint-only edits (like Markdown table alignment) for remaining warnings/errors.

**CRITICAL: Always enforce terminal command strict mode**

- **Precedence rule:** These terminal strict-mode rules override any global autonomy/persistence guidance.
- Use `timeout: 0` (infinite) for long-running, non-interactive commands.
- Expect exit code; unless explicitly indicated, no exit code means command is still running.
- Assume empty output with a successful exit code of `0` is a valid/successful completion.
- Never queue or retry while a job is active — no follow-up `echo 'OK'`, `echo $?`, `grep|tail|head`, liveness probes, log-capture reruns, wrapper reruns, or duplicate runs.

**Troubleshooting**

- **`import/no-extraneous-dependencies` after install** → Restart ESLint Server

**Add any learnings to `AGENTS.md § Learnings`:**

- Only add information that is NOT obvious from existing docs
- Focus on gotchas, workarounds, and discoveries
- Keep entries concise (1-3 lines each)
- Avoid examples as code blocks, link to real code examples in files instead
- Use the format: ``- **Topic**: Brief insight. See \`SymbolName\` in <path/to/file>.``
