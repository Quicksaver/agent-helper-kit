# AGENTS.md

This file provides context for AI agents working in this codebase.

## Project Overview

**agent-helper-kit** is a VS Code extension (TypeScript) that helps developers move review context into chat and run agent-friendly shell workflows directly in the editor.

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
- **Topic**: Brief insight (target <= 50 words). See \`SymbolName\` in <path/to/file>.
```

- **LM Tool Wiring**: Chat tools must be declared in `contributes.languageModelTools` and also registered at runtime, or they won’t be invokable. See `registerShellTools` in src/shellTools.ts.
- **Shared Shell Runtime**: Keep shell execution lifecycle (cwd handling, spill-to-file, signal cleanup) centralized to guarantee MCP server and VS Code LM tools stay behavior-identical. See `ShellRuntime` in src/shellRuntime.ts.
- **Shell Metadata Source**: Keep shell tool display names and model descriptions sourced from `package.json` `contributes.languageModelTools` to avoid drift across MCP and LM registrations. See `SHELL_TOOL_METADATA` in src/shellToolContracts.ts.
- **Prompt Reference Tool Names**: Any LM tool with `canBeReferencedInPrompt: true` must also define `toolReferenceName`, otherwise VS Code rejects registration at activation. See `contributes.languageModelTools` in package.json.
- **LM Tool Icons**: `contributes.languageModelTools` supports per-tool `icon` (Codicon like `$(terminal)` or light/dark paths), which controls the icon shown in Chat tools UI. See `contributes.languageModelTools` in package.json.
- **LM Tools Without MCP**: When tool invocation is fully covered by `contributes.languageModelTools` + `vscode.lm.registerTool`, keep shell tooling in-process and remove parallel MCP transport to reduce duplicate runtime paths. See `registerShellTools` in src/shellTools.ts.
- **Manifest Resilience**: Never let tool metadata manifest parsing throw at module import time; fallback metadata keeps extension activation resilient when packaging/manifest shape drifts. See `getContributedLanguageModelToolsSafely` in src/shellToolContracts.ts.
- **Markdown Output Fidelity**: When wrapping shell output in Markdown code fences, preserve empty output exactly; auto-appending a newline changes semantic assertions for no-output completions. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **Whitespace-Only Output Semantics**: Normalize whitespace-only shell output to the empty string, not `"\n"`, so blank completions stay distinguishable from real single-line output. See `normalizeShellOutput` in src/shellOutputFilter.ts.
- **Incremental Output Cursor**: Stream-like reads are stateful per shell command; `get_shell_output` tracks a cursor and, after completion, the second read intentionally resets to full output once before resuming delta reads. See `readBackgroundOutput` in src/shellRuntime.ts.
- **Run Tool Output Opt-In**: `run_in_sync_shell` keeps command output opt-in (`full_output`/`last_lines`/`regex`); `run_in_async_shell` is always id-only. Sync returns `id` plus status metadata by default and persists completed records so `get_shell_output` can read them later. See `runInSyncShellTool` in src/shellTools.ts.
- **Await Supports Sync IDs**: `await_shell` resolves IDs created by `run_in_sync_shell` via completed-command records and returns immediately with stored output/status. See `awaitBackgroundCommand` in src/shellRuntime.ts.
- **Output Option Contract Parity**: Keep `run_in_sync_shell` output-option exclusivity (`full_output` vs `last_lines`/`regex`) aligned in both runtime Zod validators and `package.json` JSON Schema to prevent model/runtime contract drift. See `validateRunInSyncShellInput` in src/shellToolContracts.ts.
- **Startup Purge Policy**: Startup cleanup should be age-based (mtime threshold) instead of active-id-based to avoid cross-host state assumptions while still pruning stale persisted outputs. See `initializeShellOutputStore` in src/shellOutputStore.ts.
- **Feature Toggle Completeness**: To truly disable UX features, combine runtime disposal (commands/participants/tools) with manifest `when`/`enablement` config guards so review comment buttons and command palette entries disappear immediately. See `activate` in src/extension.ts.
- **Toggle Disposal Hygiene**: When feature registrations are toggled off at runtime, dispose and remove them from `ExtensionContext.subscriptions` to avoid accumulating inert disposables during long sessions. See `disposeAndRemoveSubscription` in src/extension.ts.
- **LM Tool Visibility Toggle**: Runtime unregistration alone does not hide chat tools from the tool list after reload; guard each `contributes.languageModelTools` entry with a config `when` clause. See `contributes.languageModelTools` in package.json.
- **Panel Container IDs**: `contributes.viewsContainers.panel[].id` must use only `[a-zA-Z0-9_-]` and paired `views` entries require an explicit `icon`, or manifest validation fails. See `contributes.viewsContainers` in package.json.
- **Purge Error Isolation**: `fs.rmSync(..., { force: true })` still throws on non-ENOENT failures (for example permission issues), so startup stale-file purges should guard each artifact cleanup to avoid aborting the full scan. See `initializeShellOutputStore` in src/shellOutputStore.ts.
- **CWD Test Path Canonicalization**: macOS shell `pwd` may report `/private/var/...` while temp paths are created under `/var/...`, so cwd assertions should compare canonical paths via `realpath` to avoid false failures. See `ShellRuntime foreground cwd behavior` in src/test/shellRuntime.test.ts.
- **Shell ID Collisions Across Windows**: Per-process incremental shell command IDs can collide when multiple VS Code windows write persisted output; prefer random fixed-length hex IDs with in-memory collision checks. See `createUniqueShellId` in src/shellRuntime.ts.
- **LM Tool Split Payloads**: `LanguageModelToolResult` can return multiple parts, so shell tools can emit YAML metadata and raw output as separate text parts instead of markdown frontmatter wrapping. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **ANSI Sanitization Boundary**: Strip shell control sequences before filtering and at LM tool response packaging so `regex`/`last_lines` operate on readable text and chat output stays clean. See `stripShellControlSequences` in src/shellOutputFilter.ts.
- **Shell Tool Public IDs**: Expose only the unique command-id suffix in LM tool payloads; resolve it back to internal `shell-` prefixed IDs in runtime lookup. See `getBackgroundState` in src/shellRuntime.ts.
- **Webview View Context Actions**: When a panel view switches from TreeView to WebviewView, `view/item/context` menu contributions no longer surface per-row actions; row interactions must be handled inside webview messaging. See `ShellCommandsPanelProvider` in src/shellCommandsPanel.ts.
- **Shell Panel CSP Styling**: Webview inline CSS must be nonce-authorized by CSP (`style-src 'nonce-...'` + `<style nonce="...">`) or the panel renders as unstyled raw HTML. See `getWebviewHtml` in src/shellCommandsPanel.ts.
- **Shell Default Source**: Prefer `vscode.env.shell` as the no-input default for tool-invoked commands, and only then fall back to process env (`SHELL`/`ComSpec`) in runtime. See `getRequestedOrDefaultShell` in src/shellTools.ts.
- **Shell Run Replay Fidelity**: Persist the resolved shell path alongside each command so UI replay actions can launch a fresh shell session with the same shell even after hydration from disk. See `persistCommandMetadata` in src/shellRuntime.ts.
- **Webview Shell Replay Timing**: New shell sessions may ignore immediate `sendText` dispatches; queue replay/output + prompt paste with short staged delays so text lands after shell readiness. See `handleMessage` in src/shellCommandsPanel.ts.
- **Webview Codicon Font Source**: Codicon glyph codepoints render as squares unless icon spans use VS Code’s injected icon font variable fallback (`--vscode-icon-font-family`). See `.codicon` in src/shellCommandsPanel.ts.
- **Exit Status Shell Provenance**: Any tool payload that emits `exitCode` should also include the resolved `shell` so completion metadata remains auditable across sync, await, and incremental reads. See `getShellOutputTool` in src/shellTools.ts.
- **Regex Flag Safety**: `regex_flags` must reject stateful `g`/`y` flags for per-line filtering because `RegExp.test` mutates `lastIndex` and can skip matches across lines. See `getFilteredOutput` in src/shellOutputFilter.ts.
- **Right Sidebar Resize Math**: With command list on the right, compute width as `layoutBounds.right - mouseX` (not `mouseX - left`) so drag resizing remains intuitive and persisted width stays correct. See webview resize handler in src/shellCommandsPanel.ts.
- **Sync Run Live Tracking**: Route `run_in_sync_shell` through `startBackgroundCommand` + await/kill flow so shell runs list shows entries immediately and streams output during execution instead of only after completion. See `runInSyncShellTool` in src/shellTools.ts.
- **Single Runtime Execution Path**: Once sync tool execution is routed through background lifecycle, remove orphaned foreground runtime APIs to avoid duplicate shell execution logic paths. See `ShellRuntime` in src/shellRuntime.ts.
- **CWD Ownership Boundary**: Keep workspace cwd resolution in tool layer and pass resolved cwd into runtime command start, so runtime stays context-agnostic and reusable. See `startBackgroundCommand` in src/shellRuntime.ts.
- **Empty Tool Input Types**: For no-input LM tools, avoid empty interfaces (`{}`) because `@typescript-eslint/no-empty-object-type` rejects them; use `Record<string, never>` for strict empty-object inputs. See `GetLastShellCommandInput` in src/shellToolContracts.ts.
- **No-Input Tool Signature Parity**: Keep `invoke`/`prepareInvocation` options parameters in no-input LM tools (use `void options` if unused) to preserve `LanguageModelTool` contract consistency across registrations. See `getLastShellCommandTool` in src/shellTools.ts.
- **Local VSIX Without Repo URL**: `vsce package` can fail on README relative-link rewriting even with `--allow-missing-repository`; add `--no-rewrite-relative-links` for local packaging flows. See `package:build` in package.json.
- **Chat Open Submission Mode**: `workbench.action.chat.open` prefills chat when `isPartialQuery: true`, but omitting that flag with the same query submits the participant prompt immediately. See `handleQueuedCommentsUpdated` in src/reviewComments.ts.
- **Immediate Chat Single-Flight**: When review comments send immediately, treat chat submission as single-flight until the participant drains the queue; otherwise rapid clicks can resubmit stale pending comments. See `handleCopyCommentToChatRequest` in src/reviewComments.ts.
- **README Screenshot Packaging**: Once `package.json` declares the GitHub `repository`, README image paths can be excluded from `.vsix` via `.vscodeignore` and still resolve in Marketplace packaging. See `.vscodeignore` in .vscodeignore.
- **Shell Output Spill Boundary**: The in-memory shell output threshold should trigger an immediate switch to file-backed output, not tail truncation, so `run_in_sync_shell` and `get_shell_output` keep full history. See `appendBackgroundOutput` in src/shellRuntime.ts.
- **Incremental Spill Byte Accounting**: Size-triggered shell spills should track UTF-8 byte length per chunk instead of recomputing `Buffer.byteLength` on the full buffer each append. See `appendBackgroundOutput` in src/shellRuntime.ts.
- **Shell Completion Signal Source**: Record `exit` as the authoritative completion status, but let `close` or a short post-exit drain grace finalize the command so late piped output is preserved without leaving commands stuck running. See `recordExit` in src/shellRuntime.ts.
- **Release Bump Changelog Flow**: Version bumps should move the current `Unreleased` body under a dated `## [x.y.z] - YYYY-MM-DD` heading and insert `Version bump only.` when that block was empty. See `roll_unreleased_changelog_entries` in scripts/release.sh.
- **Release File Safety Checks**: The release script should refuse to run unless the full working tree is clean on `main`, and it should match `## [Unreleased]` headings even with trailing whitespace or no final newline. See `ensure_clean_working_tree` in scripts/release.sh.
- **Release Changelog Terminator**: Strip surrounding newline runs from the carried-over release section before appending the final terminator so releases always leave `CHANGELOG.md` with exactly one trailing newline. See `roll_unreleased_changelog_entries` in scripts/release.sh.
- **Release Notes Extraction**: Build GitHub release notes from the exact version section body in `CHANGELOG.md`, written via a temp file, so multiline notes survive CLI argument handling unchanged. See `extract_release_notes` in scripts/release.sh.
- **Shell Panel Polling Updates**: For an in-progress selection, update only the output block when output length changes; avoid replacing the full webview HTML on the poll loop so text selection remains stable. See `refreshRunningCommandOutput` in src/shellCommandsPanel.ts.
- **Tool CWD Validation**: Validate and resolve user-provided shell tool `cwd` in the tool layer before runtime spawn so bad paths fail fast with clear errors while omitted `cwd` keeps workspace/home defaults. See `resolveCommandCwd` in src/shellTools.ts.
- **Shell Color Defaults**: Pipe-based shell runs need explicit `FORCE_COLOR` and `CLICOLOR_FORCE` defaults or script-owned ANSI styling disappears outside a TTY; still honor `NO_COLOR` and caller overrides. See `buildShellEnv` in src/shellRuntime.ts.
- **Tool Availability Refresh**: Changes to contributed LM tools are not reflected in the active session until the updated extension is installed and the VS Code window is reloaded. See `contributes.languageModelTools` in package.json.
- **Shell Columns Contract Parity**: Keep shell width bounds and integer semantics aligned across runtime sanitization, Zod validation, and `package.json` schema so direct runtime callers and LM tool callers cap `COLUMNS` the same way. See `normalizeShellColumns` in src/shellColumns.ts.
- **Shell Blank-Line Normalization**: Normalize shell output on read, not on append, so LM tools and the Shell Runs panel drop whitespace-only lines consistently without chunk-boundary buffering logic. See `normalizeShellOutput` in src/shellOutputFilter.ts.
- **Shell Runs Session Scope**: Do not hydrate persisted shell command metadata into a new runtime at activation; the Shell Runs panel should reflect only commands started in the current extension session. See `ShellRuntime` in src/shellRuntime.ts.
- **Webview Message Test Timing**: Panel tests that trigger `webview.onDidReceiveMessage` need a microtask flush because the provider forwards messages with `void this.handleMessage(...)` instead of returning that promise. See `handleMessage` in src/shellCommandsPanel.ts.
- **Webview Metadata Test Hooks**: When asserting shell metadata rendering, prefer stable `data-*` attributes over raw CSS text so style-only refactors do not break behavior tests. See `buildMetadataFieldMarkup` in src/shellCommandsPanel.ts.
- **ANSI Webview Rendering**: Shell output spans need `class` only for palette-backed ANSI styles and `style` for computed RGB values; putting CSS declarations into `class` drops truecolor rendering. See `convertAnsiToHtml` in src/shellCommandsPanel.ts.
- **ANSI Render Precedence**: The shell panel ANSI renderer returns CSS classes as soon as any class-backed style is present, so tests for RGB inline declarations must avoid mixing in bold/italic/underline class flags. See `getAnsiStateStyle` in src/shellCommandsPanel.ts.
- **Shell Output Color Preservation**: Blank-line normalization must treat ANSI SGR codes as styling, not discard them from returned output; filter on visible text and only strip non-display control sequences. See `normalizeShellOutput` in src/shellOutputFilter.ts.
- **Tool Output Sanitization Boundary**: Preserve ANSI in runtime-captured shell output for the Shell Runs UI, but strip ANSI only when packaging LM tool text parts so agent-visible output stays readable. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **Spill Transition Safety**: Only mark shell output as file-backed after the overwrite to disk succeeds; otherwise keep the in-memory buffer so the Shell Runs panel and tool reads do not go blank on spill failures. See `spillOutputToFile` in src/shellRuntime.ts.
- **Temp Output Directory Recovery**: The shell-output temp root can be blocked by a file at the same path; recover by deleting that file and recreating the directory before treating spills as failed. See `ensureOutputDirectory` in src/shellOutputStore.ts.
- **Filesystem Error Diagnostics**: When file-path resolution can fail, capture the target path before the write/read so catch blocks can log the original failure instead of retriggering it. See `overwriteShellOutput` in src/shellOutputStore.ts.
- **Extension Logging Channel**: Route internal diagnostics through a dedicated VS Code output channel instead of extension-host stderr so spill and runtime failures are visible in one stable place. See `getExtensionOutputChannel` in src/logging.ts.
- **TTY Probe Guarding**: Shell helpers should only probe `/dev/tty` when at least one standard file descriptor is already a tty; otherwise Bash can emit shell-level redirection warnings before `stty` redirection takes effect. See `ui_refresh_terminal_columns` in scripts/lib/terminal-ui.sh.
- **Shell Panel Partial Refresh**: Preserve Shell Runs sidebar scroll and filter state by keeping the webview shell stable after first render and swapping only the command-list/details containers via `postMessage`. See `ShellCommandsPanelProvider.refresh` in src/shellCommandsPanel.ts.
- **Webview Ready Gate**: Do not send incremental shell panel `postMessage` updates until the webview script announces readiness, or early refresh bursts can be dropped before message listeners are attached. See `ShellCommandsPanelProvider.handleMessage` in src/shellCommandsPanel.ts.
- **Vitest Coverage Version Lockstep**: `vitest` and `@vitest/coverage-v8` must stay on the exact same version; caret drift can install an incompatible provider that fails with missing `vitest/node` exports during `--coverage`. See `test:coverage` in package.json.
- **Isolated Shell Output Test Roots**: Shell output store/runtime tests should point `AGENT_HELPER_KIT_SHELL_OUTPUT_DIR` at a suite-specific temp directory so Vitest file parallelism can stay enabled without cross-test interference. See `getOutputDirectoryPath` in src/shellOutputStore.ts.
- **NodeNext Test Imports**: Dynamic relative imports in `src/test` need explicit `.js` extensions for TypeScript linting under NodeNext resolution, even though Vitest can execute extensionless paths. See `importUriModule` in src/test/uri.test.ts.
- **Node CLI Width Shim**: Pipe-based shell runs leave `process.stdout.columns` undefined, so Node CLIs like Istanbul fall back to 80 columns unless `NODE_OPTIONS` preloads a width shim alongside `COLUMNS`/`LINES`. See `buildShellEnv` in src/shellRuntime.ts.
- **NODE_OPTIONS Shim Detection**: Width-shim reuse must recognize `--require`, `-r`, and `--require=` forms so shell runs do not append duplicate preload flags. See `buildShellEnv` in src/shellRuntime.ts.
- **Leaf Test Constants**: Constants needed before `vscode` mocks are installed should live in dependency-light modules; importing them from runtime stores can pull in `logging.ts` transitively and break Vitest module setup. See `SHELL_OUTPUT_DIR_ENV_VAR` in src/shellOutputConstants.ts.
- **Webview Flex Wrapper Constraint**: When partial panel refreshes add an intermediate details wrapper, keep that wrapper as a full-height flex column or the output block stops being the active scroll container. See `getWebviewHtml` in src/shellCommandsPanel.ts.
- **ESM FS Failure Tests**: In this Vitest setup, `node:fs` namespace exports are not configurable for `vi.spyOn`, so filesystem failure-path tests should use `vi.doMock` with a dynamic module import instead. See `importShellOutputStoreWithFsOverrides` in src/test/shellOutputStore.test.ts.
- **ESM Platform Mocking**: Platform-specific runtime tests cannot `spyOn` `node:os` namespace exports under ESM; use `vi.doMock('node:os', ...)` plus a fresh dynamic import of the module under test. See `importShellRuntimeForPlatform` in src/test/shellRuntimePlatform.test.ts.
- **Packaged Shell Shim Location**: Runtime-required helper shims cannot live under `scripts/` once `.vscodeignore` excludes that tree; keep them in a packaged root resource path. See `NODE_TERMINAL_SIZE_SHIM_PATH` in src/shellRuntime.ts.
- **Test Script Coverage Updates**: `yarn test` runs Vitest with coverage in this repo, so raised coverage can update the reported global thresholds; that is expected. See `test` in package.json.
- **Coverage Env Sanitization**: Vitest should standardize inherited shell env (`NODE_OPTIONS`, `TERM`, `COLORTERM`, `SHELL`, terminal dimensions, and color flags) before each test, or ambient terminal state can change `shellRuntime.ts` coverage without repo changes. See `src/test/setup.ts`.
- **VSIX Publish Reuse**: `vsce publish --packagePath <file>` skips the prepublish/package path and uploads the existing VSIX directly, so release flows can build once and publish that artifact without rerunning packaging hooks. See `package:publish` in package.json.
- **Vitest Vscode Mock Timing**: When a test imports modules that transitively load `vscode`, prefer file-scoped `vi.mock('vscode', ...)` over late `vi.doMock` inside helpers; full-suite runs can resolve the import before the helper mock is registered. See `importShellRuntimeForPlatform` in src/test/shellRuntimePlatform.test.ts.
- **ESLint v10 Node Floor**: Once the repo upgrades to ESLint v10, declare a matching `engines.node` range so unsupported Node versions fail fast for contributors instead of surfacing as lint startup errors. See `engines` in package.json.
