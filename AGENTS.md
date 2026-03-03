# AGENTS.md

This file provides context for AI agents working in this codebase.

## Project Overview

**custom-vscode** is a VS Code extension (TypeScript) to add custom functionality to my personal VSCode setup.

**Entry point:**

`src/extension.ts` → bundled to `dist/extension.js`.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime target:** Node 22 (bundle target), VS Code engine `^1.109.0`
- **Build:** esbuild (`esbuild.mjs`)
- **Linting:** ESLint v9 flat config + TypeScript ESLint + stylistic + perfectionist
- **Formatting:** Prettier
- **Tests:** Vitest (`src/**/*.test.ts`)
- **Package manager:** Yarn 4 (`yarn.lock` present)

## Features

**Bring code review comments into VS Code Chat:**

- Registers command: `custom-vscode.reviewCommentToChat`
- Contributes command in comment thread title menu (`Copy to Chat`)
- Registers chat participant: `custom-vscode.bringCommentsToChat` (`@bringCommentsToChat`)
- Queues selected review comments, opens chat, and streams formatted markdown with anchors/line links

## Conventions and Constraints

- Use path alias `@/*` for imports from `src/*`.
- `tsconfig.json` uses `strict: true`; avoid introducing `any` unless unavoidable.

**TypeScript Standards:**

- Use `Id<"tableName">` for document IDs
- Use `Doc<"tableName">` for document types
- Use `as const` for literal types
- Use type annotation when calling functions in same file (circularity workaround)

## Learnings

> **Purpose**: Capture critical insights from task implementations that are NOT obvious from APP_SPECS.md or PLAN.md. Keep entries concise.

**Entry Format**:

```
- **[Task ID] Topic**: Brief insight (target <= 50 words). See \`SymbolName\` in <path/to/file>.
```

- **[2026-03-02] LM Tool Wiring**: Chat tools must be declared in `contributes.languageModelTools` and also registered at runtime, or they won’t be invokable. See `registerTerminalTools` in src/terminalTools.ts.
- **[2026-03-03] Shared Terminal Runtime**: Keep terminal execution lifecycle (cwd persistence, spill-to-file, signal cleanup) centralized to guarantee MCP server and VS Code LM tools stay behavior-identical. See `TerminalRuntime` in src/terminalRuntime.ts.
- **[2026-03-03] Terminal Metadata Source**: Keep terminal tool display names and model descriptions sourced from `package.json` `contributes.languageModelTools` to avoid drift across MCP and LM registrations. See `TERMINAL_TOOL_METADATA` in src/terminalToolContracts.ts.
- **[2026-03-03] Prompt Reference Tool Names**: Any LM tool with `canBeReferencedInPrompt: true` must also define `toolReferenceName`, otherwise VS Code rejects registration at activation. See `contributes.languageModelTools` in package.json.
- **[2026-03-03] LM Tool Icons**: `contributes.languageModelTools` supports per-tool `icon` (Codicon like `$(terminal)` or light/dark paths), which controls the icon shown in Chat tools UI. See `contributes.languageModelTools` in package.json.
- **[2026-03-03] LM Tools Without MCP**: When tool invocation is fully covered by `contributes.languageModelTools` + `vscode.lm.registerTool`, keep terminal tooling in-process and remove parallel MCP transport to reduce duplicate runtime paths. See `registerTerminalTools` in src/terminalTools.ts.
- **[2026-03-03] Manifest Resilience**: Never let tool metadata manifest parsing throw at module import time; fallback metadata keeps extension activation resilient when packaging/manifest shape drifts. See `getContributedLanguageModelToolsSafely` in src/terminalToolContracts.ts.
- **[2026-03-03] Output Store Startup Safety**: Runtime startup always has zero active terminal IDs, so output-file purge must short-circuit on empty active sets to avoid deleting other process instances’ spill files. See `initializeTerminalOutputStore` in src/terminalOutputStore.ts.
- **[2026-03-03] Markdown Output Fidelity**: When wrapping terminal output in Markdown code fences, preserve empty output exactly; auto-appending a newline changes semantic assertions for no-output completions. See `buildMarkdownOutputToolResult` in src/terminalTools.ts.
- **[2026-03-03] Incremental Output Cursor**: Stream-like reads are stateful per terminal; `get_terminal_output_enhanced` tracks a cursor and, after completion, the second read intentionally resets to full output once before resuming delta reads. See `readBackgroundOutput` in src/terminalRuntime.ts.
- **[2026-03-03] Run Tool Output Opt-In**: `run_in_sync_terminal` keeps command output opt-in (`full_output`/`last_lines`/`regex`); `run_in_async_terminal` is always id-only. Sync returns `id` plus status metadata by default and persists completed records so `get_terminal_output_enhanced` can read them later. See `customRunInSyncTerminalTool` in src/terminalTools.ts.
- **[2026-03-03] Await Supports Sync IDs**: `await_terminal_enhanced` resolves IDs created by `run_in_sync_terminal` via completed-command records and returns immediately with stored output/status. See `awaitBackgroundCommand` in src/terminalRuntime.ts.
