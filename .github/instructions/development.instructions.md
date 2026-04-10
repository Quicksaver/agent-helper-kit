---
applyTo: '**'
---

These are coding standards and guidelines that apply to all files in this project.

**Acceptance criteria:**

- Lint (`yarn lint:fix`)
- Files formatted and saved (see **Format-on-save guard** below)
- All tests must pass (`yarn test`), fix as necessary

**Format-on-save guard:**

- Run `run_vscode_command("workbench.action.files.save")` first so configured format-on-save actions apply automatically.
- Only after the above steps, attempt manual formatting/lint-only edits (like Markdown table alignment) for remaining warnings/errors.

**Troubleshooting**

- **`import-x/no-extraneous-dependencies` after install** → Restart ESLint Server

**Add any learnings to `AGENTS.md § Learnings`** that fit the requirements for that section.
