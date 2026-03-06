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

- **[2026-03-02] LM Tool Wiring**: Chat tools must be declared in `contributes.languageModelTools` and also registered at runtime, or they won’t be invokable. See `registerShellTools` in src/shellTools.ts.
- **[2026-03-03] Shared Terminal Runtime**: Keep terminal execution lifecycle (cwd handling, spill-to-file, signal cleanup) centralized to guarantee MCP server and VS Code LM tools stay behavior-identical. See `TerminalRuntime` in src/shellRuntime.ts.
- **[2026-03-03] Terminal Metadata Source**: Keep terminal tool display names and model descriptions sourced from `package.json` `contributes.languageModelTools` to avoid drift across MCP and LM registrations. See `SHELL_TOOL_METADATA` in src/shellToolContracts.ts.
- **[2026-03-03] Prompt Reference Tool Names**: Any LM tool with `canBeReferencedInPrompt: true` must also define `toolReferenceName`, otherwise VS Code rejects registration at activation. See `contributes.languageModelTools` in package.json.
- **[2026-03-03] LM Tool Icons**: `contributes.languageModelTools` supports per-tool `icon` (Codicon like `$(terminal)` or light/dark paths), which controls the icon shown in Chat tools UI. See `contributes.languageModelTools` in package.json.
- **[2026-03-03] LM Tools Without MCP**: When tool invocation is fully covered by `contributes.languageModelTools` + `vscode.lm.registerTool`, keep terminal tooling in-process and remove parallel MCP transport to reduce duplicate runtime paths. See `registerShellTools` in src/shellTools.ts.
- **[2026-03-03] Manifest Resilience**: Never let tool metadata manifest parsing throw at module import time; fallback metadata keeps extension activation resilient when packaging/manifest shape drifts. See `getContributedLanguageModelToolsSafely` in src/shellToolContracts.ts.
- **[2026-03-03] Markdown Output Fidelity**: When wrapping terminal output in Markdown code fences, preserve empty output exactly; auto-appending a newline changes semantic assertions for no-output completions. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **[2026-03-03] Incremental Output Cursor**: Stream-like reads are stateful per terminal; `get_terminal_output_enhanced` tracks a cursor and, after completion, the second read intentionally resets to full output once before resuming delta reads. See `readBackgroundOutput` in src/shellRuntime.ts.
- **[2026-03-03] Run Tool Output Opt-In**: `run_in_sync_shell` keeps command output opt-in (`full_output`/`last_lines`/`regex`); `run_in_async_shell` is always id-only. Sync returns `id` plus status metadata by default and persists completed records so `get_shell_output` can read them later. See `customRunInSyncShellTool` in src/shellTools.ts.
- **[2026-03-03] Await Supports Sync IDs**: `await_terminal_enhanced` resolves IDs created by `run_in_sync_terminal` via completed-command records and returns immediately with stored output/status. See `awaitBackgroundCommand` in src/shellRuntime.ts.
- **[2026-03-03] Output Option Contract Parity**: Keep `run_in_sync_shell` output-option exclusivity (`full_output` vs `last_lines`/`regex`) aligned in both runtime Zod validators and `package.json` JSON Schema to prevent model/runtime contract drift. See `validateRunInSyncShellInput` in src/shellToolContracts.ts.
- **[2026-03-04] Startup Purge Policy**: Startup cleanup should be age-based (mtime threshold) instead of active-id-based to avoid cross-host state assumptions while still pruning stale persisted outputs. See `initializeTerminalOutputStore` in src/shellOutputStore.ts.
- **[2026-03-04] Feature Toggle Completeness**: To truly disable UX features, combine runtime disposal (commands/participants/tools) with manifest `when`/`enablement` config guards so review comment buttons and command palette entries disappear immediately. See `activate` in src/extension.ts.
- **[2026-03-04] Toggle Disposal Hygiene**: When feature registrations are toggled off at runtime, dispose and remove them from `ExtensionContext.subscriptions` to avoid accumulating inert disposables during long sessions. See `disposeAndRemoveSubscription` in src/extension.ts.
- **[2026-03-04] LM Tool Visibility Toggle**: Runtime unregistration alone does not hide chat tools from the tool list after reload; guard each `contributes.languageModelTools` entry with a config `when` clause. See `contributes.languageModelTools` in package.json.
- **[2026-03-04] Panel Container IDs**: `contributes.viewsContainers.panel[].id` must use only `[a-zA-Z0-9_-]` and paired `views` entries require an explicit `icon`, or manifest validation fails. See `contributes.viewsContainers` in package.json.
- **[2026-03-04] Purge Error Isolation**: `fs.rmSync(..., { force: true })` still throws on non-ENOENT failures (for example permission issues), so startup stale-file purges should guard each artifact cleanup to avoid aborting the full scan. See `initializeTerminalOutputStore` in src/shellOutputStore.ts.
- **[2026-03-05] CWD Test Path Canonicalization**: macOS shell `pwd` may report `/private/var/...` while temp paths are created under `/var/...`, so cwd assertions should compare canonical paths via `realpath` to avoid false failures. See `TerminalRuntime foreground cwd behavior` in src/test/shellRuntime.test.ts.
- **[2026-03-05] Terminal ID Collisions Across Windows**: Per-process incremental terminal IDs can collide when multiple VS Code windows write persisted output; prefer random fixed-length hex IDs with in-memory collision checks. See `createUniqueTerminalId` in src/shellRuntime.ts.
- **[2026-03-05] LM Tool Split Payloads**: `LanguageModelToolResult` can return multiple parts, so terminal tools can emit YAML metadata and raw output as separate text parts instead of markdown frontmatter wrapping. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **[2026-03-05] ANSI Sanitization Boundary**: Strip terminal control sequences before filtering and at LM tool response packaging so `regex`/`last_lines` operate on readable text and chat output stays clean. See `stripTerminalControlSequences` in src/shellOutputFilter.ts.
- **[2026-03-05] Shell Tool Public IDs**: Expose only the unique command-id suffix in LM tool payloads; resolve it back to internal `custom-shell-` prefixed IDs in runtime lookup. See `getBackgroundState` in src/shellRuntime.ts.
- **Webview View Context Actions**: When a panel view switches from TreeView to WebviewView, `view/item/context` menu contributions no longer surface per-row actions; row interactions must be handled inside webview messaging. See `ShellCommandsPanelProvider` in src/shellCommandsPanel.ts.
- **Shell Panel CSP Styling**: Webview inline CSS must be nonce-authorized by CSP (`style-src 'nonce-...'` + `<style nonce="...">`) or the panel renders as unstyled raw HTML. See `getWebviewHtml` in src/shellCommandsPanel.ts.
- **[2026-03-05] Shell Default Source**: Prefer `vscode.env.shell` as the no-input default for tool-invoked commands, and only then fall back to process env (`SHELL`/`ComSpec`) in runtime. See `getRequestedOrDefaultShell` in src/shellTools.ts.
- **[2026-03-05] Shell Run Replay Fidelity**: Persist the resolved shell path alongside each command so UI replay actions can launch a fresh terminal with the same shell even after hydration from disk. See `persistCommandMetadata` in src/shellRuntime.ts.
- **[2026-03-05] Webview Terminal Replay Timing**: New terminals may ignore immediate `sendText` dispatches; queue replay/output + prompt paste with short staged delays so text lands after terminal readiness. See `handleMessage` in src/shellCommandsPanel.ts.
- **[2026-03-05] Webview Codicon Font Source**: Codicon glyph codepoints render as squares unless icon spans use VS Code’s injected icon font variable fallback (`--vscode-icon-font-family`). See `.codicon` in src/shellCommandsPanel.ts.
- **[2026-03-05] Exit Status Shell Provenance**: Any tool payload that emits `exitCode` should also include the resolved `shell` so completion metadata remains auditable across sync, await, and incremental reads. See `customGetShellOutputTool` in src/shellTools.ts.
- **[2026-03-05] Regex Flag Safety**: `regex_flags` must reject stateful `g`/`y` flags for per-line filtering because `RegExp.test` mutates `lastIndex` and can skip matches across lines. See `getFilteredOutput` in src/shellOutputFilter.ts.
- **[2026-03-05] Right Sidebar Resize Math**: With command list on the right, compute width as `layoutBounds.right - mouseX` (not `mouseX - left`) so drag resizing remains intuitive and persisted width stays correct. See webview resize handler in src/shellCommandsPanel.ts.
- **[2026-03-05] Sync Run Live Tracking**: Route `run_in_sync_shell` through `startBackgroundCommand` + await/kill flow so shell runs list shows entries immediately and streams output during execution instead of only after completion. See `customRunInSyncShellTool` in src/shellTools.ts.
- **[2026-03-05] Single Runtime Execution Path**: Once sync tool execution is routed through background lifecycle, remove orphaned foreground runtime APIs to avoid duplicate shell execution logic paths. See `TerminalRuntime` in src/shellRuntime.ts.
- **[2026-03-05] CWD Ownership Boundary**: Keep workspace cwd resolution in tool layer and pass resolved cwd into runtime command start, so runtime stays context-agnostic and reusable. See `startBackgroundCommand` in src/shellRuntime.ts.
- **[2026-03-06] Empty Tool Input Types**: For no-input LM tools, avoid empty interfaces (`{}`) because `@typescript-eslint/no-empty-object-type` rejects them; use `Record<string, never>` for strict empty-object inputs. See `GetLastShellCommandInput` in src/shellToolContracts.ts.
- **[2026-03-06] No-Input Tool Signature Parity**: Keep `invoke`/`prepareInvocation` options parameters in no-input LM tools (use `void options` if unused) to preserve `LanguageModelTool` contract consistency across registrations. See `customGetLastShellCommandTool` in src/shellTools.ts.
