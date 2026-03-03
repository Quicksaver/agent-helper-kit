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
- **[2026-03-02] MCP Provider Wiring**: Dynamic MCP servers require both `contributes.mcpServerDefinitionProviders` and runtime `lm.registerMcpServerDefinitionProvider`; either one missing prevents discovery. See `registerMcpServerProvider` in src/mcpProvider.ts.
- **[2026-03-03] Shared Terminal Runtime**: Keep terminal execution lifecycle (cwd persistence, spill-to-file, signal cleanup) centralized to guarantee MCP server and VS Code LM tools stay behavior-identical. See `TerminalRuntime` in src/terminalRuntime.ts.
- **[2026-03-03] Terminal Metadata Source**: Keep terminal tool display names and model descriptions sourced from `package.json` `contributes.languageModelTools` to avoid drift across MCP and LM registrations. See `TERMINAL_TOOL_METADATA` in src/terminalToolContracts.ts.
- **[2026-03-03] Manifest Resilience**: Never let tool metadata manifest parsing throw at module import time; fallback metadata keeps extension activation and MCP startup resilient when packaging/manifest shape drifts. See `getContributedLanguageModelToolsSafely` in src/terminalToolContracts.ts.
