# AGENTS.md

This file provides context for AI agents working in this codebase.

## Project Overview

**agent-helper-kit** is a VS Code extension (TypeScript) that helps developers move review context into chat and run agent-friendly shell workflows directly in the editor.

**Entry point:**

`src/extension.ts` → bundled to `dist/extension.js`.

## Documentation

- **INTEGRATION_SECURITY.md** describes the security model and integration points for LM tools, shell runtimes, and the approval system, mostly adapted from VS Code's core functionality.
- **README.md** at root, provides project features and description.

## Tech Stack

- **Language:** TypeScript
- **Build:** esbuild (`esbuild.mjs`)
- **Linting:** ESLint v10 flat config + TypeScript ESLint + stylistic + perfectionist
- **Formatting:** Prettier
- **Tests:** Vitest (`src/**/*.test.ts`)
- **Package manager:** Yarn 4 (`yarn.lock` present)

## Conventions and Constraints

- Use path alias `@/*` for imports from `src/*`.

## Type Safety

- Never use `any`
- Prefer type inference for function return signatures

## Learnings

> **Purpose**: Capture critical concise (1-3 lines) insights that are NOT obvious from code or included documentation, and will be helpful for future development and maintenance.
>
> **Focus**:
>
> - non-obvious gotchas, workarounds, and discoveries
> - repeated failure modes
> - decision-shaping constraints
> - design and structural patterns that encode project conventions, preserve consistency, protect APIs, or prevent recurring bad usage patterns
> - entries that explain why a pattern exists, not just what the code does
>
> **Discard**:
>
> - information already obvious from docs, symbol names, or standard library/framework behavior
> - issues normally surfaced by normal tooling, such as build errors, test failures, or lint warnings
> - examples as code blocks, link to real code examples in files instead
> - generic best practices unless their use here protects a real repository boundary or recurring failure mode
> - duplicate restatements of the same pattern in multiple areas
> - historical details unless they still affect current design or maintenance decisions
>
> **Entry Format**:
>
> ```
> - **[Area] Topic**: Brief insight (target <= 50 words). See \`SymbolName\` in <path/to/file>.
> ```
>
> Use `Area` as a stable keyword describing the part of the system affected.
> Examples: `build`, `compatibility`, `tests`, `runtime`, `cache`, `layout`, `style`, `dashboard`, `auth`, `blog`, `api`, `lib`, `react`, `analytics`.
>
> **Example**:
>
> ```
> - **[lib] Brevo v4 SDK**: Responses return parsed data directly (no `.body`/`.response`), and raw HTTP details require `.withRawResponse()`. See `submit` in lib/brevo/actions.ts.
> ```

- **[tools] LM Tool Registration**: Shell tools must stay declared in `package.json` and registered at runtime, and their user-facing metadata should keep coming from the manifest with a safe fallback when parsing fails. See `registerShellTools` in src/shellTools.ts.
- **[tools] Tool Description Split**: When both manifest descriptions exist, UI-facing metadata should use `userDescription` and fall back to `modelDescription`; keep runtime parsing aligned with `package.json` so custom prompts and surfaced tool text do not drift. See `getToolMetadata` in src/shellToolContracts.ts.
- **[tools] Description Normalization Boundary**: Normalize manifest descriptions once while parsing `contributes.languageModelTools`; treat blank required `modelDescription` values as invalid and let downstream metadata builders rely on the sanitized results instead of re-trimming them. See `getContributedLanguageModelToolsFromManifest` in src/shellToolContracts.ts.
- **[tools] Shell Run Timeout Semantics**: `run_in_shell.timeout` limits only how long the tool waits before responding; if it expires, the command keeps running and callers must await or kill it explicitly. See `runInShellTool` in src/shellTools.ts.
- **[tools] Prompt Reference Names**: Any LM tool with `canBeReferencedInPrompt: true` also needs `toolReferenceName`, or VS Code rejects registration during activation. See `contributes.languageModelTools` in package.json.
- **[tools] Prepared Shell Signature Width**: Include validated `columns` in the prepare/invoke reservation signature, or identical commands with different terminal widths can claim the wrong pre-run row. See `buildPreparedRunInShellSignature` in src/shellTools.ts.
- **[approval] Read-Only Rule Specificity**: Prefer subcommand-specific regex allow rules for shell approval instead of broad command-name allows; named rules over-approve write-capable variants like `git branch`. See `DEFAULT_APPROVAL_RULES` in src/shellToolSecurity.ts.
- **[extension] Feature Toggle Completeness**: Disabling a feature requires both runtime disposal and manifest `when`/`enablement` guards; unregistering alone leaves commands or chat tools visible after reload. See `activate` in src/extension.ts.
- **[runtime] Tool Boundary**: Resolve workspace-relative `cwd` and other editor-context defaults in the tool layer, then pass concrete values into `ShellRuntime`; this keeps runtime reusable and testable. See `resolveCommandCwd` in src/shellTools.ts.
- **[runtime] Single Execution Path**: Keep sync and async shell runs on the same background-command lifecycle so IDs, streaming reads, kill behavior, and the Shell Runs panel stay consistent. See `runInSyncShellTool` in src/shellTools.ts.
- **[runtime] Completion Drain**: Treat process `exit` as authoritative status, but finalize on `close` or a short drain timer so piped output arriving after exit is not lost. See `recordExit` in src/shellRuntime.ts.
- **[runtime] Public Shell IDs**: Expose only the suffix externally and generate random internal IDs; per-process counters collide across VS Code windows when persisted artifacts share a temp directory. See `createUniqueShellId` in src/shellRuntime.ts.
- **[output] Read-Time Normalization**: Normalize shell output when reading, not while appending, so blank-line filtering stays consistent across LM tools, persisted output, and the Shell Runs panel. See `normalizeShellOutput` in src/shellOutputFilter.ts.
- **[output] ANSI Boundary**: Preserve ANSI in runtime-captured output for the panel, but strip it only when packaging LM tool results; otherwise the UI loses color or chat output becomes unreadable. See `buildSplitOutputToolResult` in src/shellTools.ts.
- **[store] Spill Resilience**: Spilling to disk must preserve full history, and file-backed state should flip only after a successful write; failed spills need an in-memory fallback instead of blank reads. See `spillOutputToFile` in src/shellRuntime.ts.
- **[store] Temp Root Recovery**: The shell-output temp root can be blocked by a file at the same path; recover by deleting that blocker before treating storage as failed. See `ensureOutputDirectory` in src/shellOutputStore.ts.
- **[panel] Stable Refreshes**: After first render, keep the webview shell stable and patch it with `postMessage`; replace only the output block during polling, and only after the webview sends `ready`. See `ShellCommandsPanelProvider.refresh` in src/shellCommandsPanel.ts.
- **[panel] Row Interaction Boundary**: Once the Shell Runs UI moved to `WebviewView`, per-row `view/item/context` actions stopped existing, so row actions have to flow through webview messages. See `ShellCommandsPanelProvider.handleMessage` in src/shellCommandsPanel.ts.
- **[approval] Fail-Closed Parsing**: Approval runs in `prepareInvocation` and must parse every subcommand, including newline-separated commands; ambiguous syntax and conflicting case variants require explicit approval, while transient env-var prefixes preserve ask/deny rules and suppress allow auto-runs so unresolved commands defer to model review unless YOLO is explicitly enabled. See `analyzeShellRunRuleDisposition` in src/shellToolSecurity.ts.
- **[approval] File-Write Allow Suppression**: Detected output redirections should suppress matching allow rules without bypassing the normal ask/deny or model-review flow; this keeps write detection conservative without turning every redirect into a hard approval prompt. See `analyzeShellRunRuleDisposition` in src/shellToolSecurity.ts.
- **[approval] Descriptor Duplication Boundary**: Treat descriptor duplication like `2>&1` as non-file redirection, but keep suppressing allow rules for file-target output redirects such as `>`, `>>`, `>|`, or `>&file`. See `splitShellSubcommandsWithMetadata` in src/shellToolSecurity.ts.
- **[approval] Shared Shell Scanner**: Keep transient env stripping and subcommand splitting on the same character scanner so quote, escape, substitution, and separator handling cannot drift into inconsistent approval decisions. See `scanShellCharacter` in src/shellToolSecurity.ts.
- **[approval] Regex Rule Hardening**: User regex rules must reject stateful flags and fail closed on invalid, vulnerable, or inconclusive `recheck` results, with one longer-timeout retry for transient validation timeouts. See `validateConfiguredRegexRule` in src/shellToolSecurity.ts.
- **[build] Runtime Dependency Bundling**: VSIX packaging uses `vsce --no-dependencies`, so extension-host runtime deps like `recheck` must stay bundled unless packaging explicitly ships them; otherwise activation fails on missing `require(...)` imports. See `extensionBuildOptions` in esbuild.mjs.
- **[risk] Async Approval Path**: `LanguageModelTool.prepareInvocation` can be async, which lets shell approval combine explicit rules with model-based risk assessment and file-backed context before deciding whether to prompt. See `decideShellRunApproval` in src/shellToolSecurity.ts.
- **[risk] Cache Key Normalization**: Session-scoped shell risk assessment must canonicalize cwd and file context paths and ignore context ordering, or retries miss the cache when the same file is referenced via relative and absolute paths. See `buildRiskAssessmentCacheKey` in src/shellRiskAssessment.ts.
- **[risk] Cache Only Model Responses**: Session risk-assessment caching must evict `error` and `timeout` results so transient model outages do not block identical retries until window reload. See `assessShellCommandRisk` in src/shellRiskAssessment.ts.
- **[risk] Output Audit Trail**: Log shell risk-assessment prompts, raw model responses, and cached outcomes from `assessShellCommandRisk` so approval debugging can explain why model-backed decisions were reused or failed. See `assessShellCommandRisk` in src/shellRiskAssessment.ts.
- **[risk] Audit Log Truncation**: Keep shell risk-assessment prompt and raw-response audit logs bounded, because prompt context can embed large file bodies and the output channel still needs to stay readable for approval debugging. See `truncateRiskAssessmentLogText` in src/shellRiskAssessment.ts.
- **[shell] Pipe-Run Environment**: Non-interactive shell runs need explicit color defaults and a `NODE_OPTIONS` width shim; otherwise ANSI styling disappears and Node CLIs fall back to 80-column output. See `buildShellEnv` in src/shellRuntime.ts.
- **[shell] Git Non-Interactive Defaults**: Force `GIT_PAGER=cat`, `GIT_MERGE_AUTOEDIT=no`, `GIT_EDITOR=:`, and `GIT_TERMINAL_PROMPT=0` in `ShellRuntime` so spawned git commands cannot hand control to a pager, editor, or terminal credential prompt. See `buildShellEnv` in src/shellRuntime.ts.
- **[shell] Input Writes Stay Pipe-Only**: `send_to_shell` writes to child-process stdin for `run_in_shell`, but these runs still do not allocate a PTY, so terminal-bound prompts like many `ssh`/`sudo` password flows remain unsupported. See `sendInputToBackgroundCommand` in src/shellRuntime.ts.
- **[runtime] Stdin Log Redaction Boundary**: Log `send_to_shell` writes through the runtime output stream so Shell Runs, persisted logs, and `get_shell_output` stay aligned, and redact secret inputs at write time instead of trying to filter them during reads. See `sendInputToBackgroundCommand` in src/shellRuntime.ts.
- **[shell] Single-Line Send Input**: `send_to_shell` appends Enter itself, so its `command` payload must stay single-line; unknown ids should degrade to a structured failure instead of throwing to keep interactive retries stable. See `validateSendToShellInput` in src/shellToolContracts.ts and `sendInputToBackgroundCommand` in src/shellRuntime.ts.
- **[shell] History Suppression Scope**: VS Code core shell-history suppression does not map directly to this extension's spawned non-interactive shell runtime; the more relevant local persistence surface is temp shell metadata/output. See `startBackgroundCommand` in src/shellRuntime.ts and `writeShellCommandMetadata` in src/shellOutputStore.ts.
- **[panel] Pre-Run Shell Entries**: Shell Runs should reserve a runtime record during `run_in_shell.prepareInvocation` and reuse that id when execution starts, so approval-pending, denied, and running states stay attached to one row instead of duplicating entries. See `runInShellTool` in src/shellTools.ts and `startBackgroundCommand` in src/shellRuntime.ts.
- **[tools] Prepared Shell Reservation Cleanup**: Matching `run_in_shell` prepares must claim reserved ids in FIFO order and discard stale reservations on cancellation or timeout, or identical prepares can attach execution to the wrong row and strand pending entries in Shell Runs. See `queuePreparedRunInShellCommandId` in src/shellTools.ts.
- **[build] Packaged Shim Placement**: Runtime-required helper shims cannot live under `scripts/` once packaging excludes that tree; keep required runtime assets in a packaged resource path. See `NODE_TERMINAL_SIZE_SHIM_PATH` in src/shellRuntime.ts.
- **[tests] Shell Env Determinism**: Coverage and shell-runtime behavior drift with inherited terminal env, so tests must normalize shell, color, terminal-size, and `NODE_OPTIONS` variables before each run. See `applyControlledTestEnvironment` in src/test/setup.ts.
- **[tests] Isolated Output Roots**: Shell output store tests need a suite-specific temp directory via `AGENT_HELPER_KIT_SHELL_OUTPUT_DIR`, or parallel Vitest files interfere with each other. See `getOutputDirectoryPath` in src/shellOutputStore.ts.
- **[tests] ESM Mocking Limits**: Under this Vitest/ESM setup, `node:fs` and `node:os` namespace exports are poor `spyOn` targets; use `vi.doMock` and a fresh dynamic import of the module under test instead. See `importShellRuntimeForPlatform` in src/test/shellRuntimePlatform.test.ts.
- **[tests] Cross-Platform Write Failures**: Permission flips like `chmod` are not a reliable way to force write failures across platforms; prefer a partial `vi.doMock` of the storage layer plus a fresh import when testing runtime fallback paths. See `falls back to in-memory state when persisted send_to_shell log removal cannot overwrite the file` in src/test/shellRuntime.test.ts.
- **[tests] VS Code Mock Timing**: When a module transitively imports `vscode`, prefer file-scoped `vi.mock('vscode')`; helper-scoped `vi.doMock` can miss during full-suite imports. See `importShellRuntimeForPlatform` in src/test/shellRuntimePlatform.test.ts.
- **[tests] Temp Directory Lifecycle**: If suite teardown removes a temp directory in `afterEach`, create that directory in `beforeEach` rather than at module load or later tests can inherit deleted paths. See `shellOutputTestDirectory` in src/test/shellToolsPlatform.test.ts.
- **[release] Release Script Invariants**: Releases must start from a clean `main`, move the current Unreleased body under a dated version heading, and emit `Version bump only.` when that section is empty. See `roll_unreleased_changelog_entries` in scripts/release.sh.
- **[release] Release Notes Extraction**: Build release notes from the exact version section written to a temp file; passing multiline notes through CLI arguments loses formatting. See `extract_release_notes` in scripts/release.sh.
- **[scripts] TTY Probe Guard**: Terminal UI helpers should probe `/dev/tty` only when one of stdin/stdout/stderr is already a tty, or Bash can emit redirection noise before `stty` is silenced. See `ui_refresh_terminal_columns` in scripts/lib/terminal-ui.sh.
- **[tests] Test Script Coverage Updates**: `yarn test` runs Vitest with coverage in this repo, so raised coverage can update the reported global thresholds; that is expected and always acceptable. See `test` in package.json.
