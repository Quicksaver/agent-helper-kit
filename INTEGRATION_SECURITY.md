# Integrating Terminal Tool Security in a Third-Party VS Code Extension

This document explains how VS Code core secures the `run_in_terminal` chat tool and how a third-party extension can replicate the same behavior as closely as possible within public extension APIs.

The focus is implementation guidance, not just feature listing:

- why each control exists
- what the control is expected to guarantee
- what a third-party extension should replicate
- the exact core reference snippet to mirror

## Important Scope Note

All file, symbol, and line references to VS Code core in this document are **internal markers only**.

They are included so you can:

- compare your extension against current core behavior
- diff future upstream changes
- update this guide when core changes

Do **not** attempt to import or call these internal core files directly from a third-party extension. A marketplace extension will not have access to them.

## Implementation Priorities

If you cannot replicate everything, prioritize in this order:

1. explicit confirmation before execution
2. deny auto-approval for dangerous commands
3. file-write detection and approval escalation
4. sandboxing or equivalent containment
5. unsandboxed escape hatch with explicit reason
6. shell-history suppression
7. output and telemetry sanitization

## Progress

1. **Default confirmation gate**: Implemented. Shell tools build confirmation messages in `prepareInvocation` and include command, cwd, explanation, goal, and the required caller-supplied risk summary.
2. **Auto-approval gating**: Implemented with a different scope. The previous double opt-in design was intentionally removed in favor of explicit `allow`/`ask`/`deny` rules, optional model-based risk assessment, and a single explicit YOLO override.
3. **Default allowlist and denylist rules**: Implemented. Safe read-oriented commands can run without prompting, dangerous commands are denied outright, and undecided commands fall through to model review or manual confirmation.
4. **Dangerous variants of otherwise safe commands**: Implemented. Regex-backed rules still block unsafe variants such as `find -delete`, `rg --pre`, and in-place or write-capable `sed` forms.
5. **Subcommand parsing**: Implemented. Compound commands are parsed conservatively and fail closed to explicit approval when parsing is ambiguous.
6. **Transient environment variable prefixes**: Implemented with a deliberate divergence from core. The extension strips leading transient assignments before rule matching, preserves matching `ask` and `deny` outcomes, suppresses `allow` auto-runs, and routes unresolved commands to model review or explicit confirmation.
7. **File-write detection**: Implemented with a deliberate divergence from core. Detected output redirections suppress matching `allow` rules in the same way transient prefixes do, but they preserve `ask` and `deny` outcomes and otherwise fall through to model review or explicit confirmation.
8. **Workspace-only package scripts**: Intentionally not implemented. Instead, callers should pass relevant script definitions or alias expansions through `riskAssessmentContext`, and the risk-assessment prompt explicitly requests manual confirmation when that context is insufficient.
9. **Prompt-injection and script-injection review**: Implemented with a different UX. The extension does not show a separate disclaimer message for web fetchers; instead, default deny rules cover obvious fetchers and the risk-assessment prompt explicitly asks the model to review fetched-content and script-injection hazards.
10. **Sandboxing and unsandboxed retry paths**: Intentionally not implemented for now. The extension does not currently implement sandboxing and sandbox-driven retry flows because many of the commands it is expected to run would be blocked by a strict sandbox, and the added friction of sandbox-driven retries would be counterproductive for the current use cases. This tradeoff may be revisited in the future.
11. Sandboxing -- as above
12. Sandboxing -- as above
13. Sandboxing -- as above
14. Sandboxing -- as above
15. Sandboxing -- as above
16. Sandboxing -- as above
17. Sandboxing -- as above
18. TBD
19. **Output sanitization and truncation**: Implemented with a deliberate divergence from core. The runtime preserves display-oriented ANSI SGR styling for the Shell Runs panel, strips non-display control sequences during normalization, and strips all remaining control sequences before output is returned in LM tool results.
20. **Telemetry sanitization**: Not currently applicable. The extension does not currently emit remote telemetry for shell tool usage; current diagnostics use a local VS Code output channel rather than a telemetry pipeline. If telemetry is added later, raw command text should be treated as sensitive input and sanitized before emission.
21. **Specialized-tool routing instead of shell execution**: Not currently applicable. This extension does not currently supply alternate structured tools for shell-adjacent requests, and it intentionally leaves tool selection to the agent rather than trying to override that decision inside the extension. This may be revisited in the future.

## Third-Party Extension Divergence Notes

These notes are intentionally preserved because they describe the behavior of this third-party extension this guide is meant to support. They are not claims about the checked-in VS Code core implementation at the reference snapshot above.

That third-party extension intentionally diverges from VS Code core in several areas:

- it does **not** use a double opt-in gate for shell auto-approval
- it requires each shell run request to include a human-readable `riskAssessment`
- it may include `riskAssessmentContext` entries that are either file pointers or inline descriptions of relevant sub-actions so the extension can load source and pass alias/script context into model review
- it uses tri-state approval rules: `allow`, `ask`, `deny`
- it can optionally ask a configured chat model to return a deterministic `allow`, `request`, or `deny` risk decision for commands that are not already decided by explicit rules
- it caches risk-assessment results for the current session using normalized command, cwd, and context fingerprints so retries do not keep re-prompting the model
- it exposes a deliberately dangerous YOLO-style override for users who want zero confirmation prompts on unresolved commands after explicit rules are checked
- detected file-write redirections suppress matching `allow` rules but otherwise stay on the normal model-review or explicit-confirmation path instead of forcing a dedicated file-write block
- it does not implement workspace-only package-script auto-approval; package scripts should be evaluated through `riskAssessmentContext` and the model prompt fails closed when script context is incomplete
- it does not surface a dedicated prompt-injection disclaimer for web fetchers; instead, deny rules and the risk-assessment prompt cover fetched-content and script-injection risks

Section 2 below still describes the current VS Code core behavior. Treat these divergence notes as a downstream design delta for the third-party app, not as a replacement for the core reference.

## Reference Snapshot

- VS Code core commit: [0e5f2c4f5c1fdb962a528d20b67a5f234bad2c08](https://github.com/microsoft/vscode/commit/0e5f2c4f5c1fdb962a528d20b67a5f234bad2c08)
- Reviewed against: 2026-04-10

## Current Core Snapshot

This document now tracks the current VS Code core implementation in this repository. The divergence notes for the third-party app are still relevant as downstream context, but they should be read separately from the current-core snapshot below.

The current core behavior relevant to this guide is:

- terminal-specific auto-approval still uses a double opt-in gate: `chat.tools.terminal.enableAutoApprove` plus the stored `TerminalAutoApproveWarningAccepted` flag, and it also honors per-tool eligibility
- terminal commands are evaluated through layered analyzers: subcommand parsing, default/user/workspace/session allow and deny rules, file-write detection, prompt-injection warnings, workspace npm/yarn/pnpm script approval, and sandbox-aware auto-approval
- higher-level chat approval modes sit above terminal-specific rules. Session permission levels such as Autopilot and Bypass Approvals, plus `chat.tools.global.autoApprove`, can suppress terminal confirmations independently of terminal rule matching
- sandbox rewriting now checks prerequisites, can interrupt execution with a missing-dependencies install prompt, and can switch a command into an unsandboxed-confirmation path when command text references blocked or non-allowed domains
- sandbox settings now live under `chat.agent.sandbox.*`. The older trusted-domain merge behavior is not part of the current implementation

## Security Model Summary

The core model is layered:

1. most commands require confirmation
2. terminal-specific auto-approval requires explicit enablement and opt-in
3. clearly safe commands can be auto-approved by built-in, user, workspace, or session rules
4. dangerous commands and dangerous variants stay pending approval
5. file writes and suspicious patterns can disable auto-approval
6. higher-level chat approval modes can bypass terminal-specific confirmation
7. sandboxing constrains network and filesystem access when enabled
8. missing sandbox prerequisites, blocked domains, and unsandboxed retries take stronger confirmation or install flows
9. shell history, output, and telemetry are sanitized to reduce leakage

## Current Core Coverage

The current VS Code core implementation covers the main priorities in this document as follows:

1. **Default confirmation gate**: Implemented. `prepareToolInvocation` builds the confirmation payload and only suppresses it after terminal-specific and session-level approval checks.
2. **Terminal-specific auto-approval gating**: Implemented. Core still requires `chat.tools.terminal.enableAutoApprove`, the terminal opt-in warning, and per-tool eligibility before rule matches can auto-run a command.
3. **Default allowlist and denylist rules**: Implemented. The built-in rules now cover basic read-only commands, selected `git`/`docker`/package-manager subcommands, safe lockfile installs, and explicit denials for dangerous commands.
4. **Dangerous variants of otherwise safe commands**: Implemented. Regex-backed rules still block unsafe forms such as `find -delete`, `rg --pre`, `sort -o`, `tree -o`, and risky `sed` usage.
5. **Subcommand parsing**: Implemented. Compound commands are parsed via tree-sitter and ambiguous parsing fails closed.
6. **Sandbox prerequisites and dependency install flow**: Implemented. Missing sandbox dependencies are detected before execution and surfaced through a dedicated install confirmation path.
7. **Blocked-domain detection and unsandboxed escalation**: Implemented. Commands that reference denied or non-allowed domains can be rerouted into an unsandboxed confirmation flow before execution.

## 1. Default Confirmation Gate

### Why

The baseline security property is that commands should not execute silently. Confirmation is the default path. Auto-approval is an exception, not the norm.

### Expected Behavior

- Show a confirmation UI for terminal commands by default.
- Include the model's explanation and goal in the prompt.
- If the command is leaving a sandbox, show the sandbox escape reason too.
- If sandbox prerequisites are missing, replace the normal run confirmation with a dedicated install-or-cancel prompt.
- Only skip confirmation when a command is explicitly auto-approved or the session is in a bypass-approvals mode.

### Third-Party Extension Guidance

Implement a single `prepareToolInvocation` stage that always constructs a confirmation payload first, then decides whether it can be suppressed.

At minimum, your confirmation should show:

- command text
- cwd if known
- explanation
- goal
- unsandbox reason if applicable

### Core Reference Snippet

```ts
// If forceConfirmationReason is set, always show confirmation regardless of auto-approval
const shouldShowConfirmation =
  (!isFinalAutoApproved && !isSessionAutoApproved) || context.forceConfirmationReason !== undefined;
const confirmationMessage = requiresUnsandboxConfirmation
  ? new MarkdownString(
      localize(
        'runInTerminal.unsandboxed.confirmationMessage',
        'Explanation: {0}\n\nGoal: {1}\n\nReason for leaving the sandbox: {2}',
        args.explanation,
        args.goal,
        requestUnsandboxedExecutionReason ||
          localize(
            'runInTerminal.unsandboxed.confirmationMessage.defaultReason',
            'The model indicated that this command needs unsandboxed access.',
          ),
      ),
    )
  : new MarkdownString(
      localize('runInTerminal.confirmationMessage', 'Explanation: {0}\n\nGoal: {1}', args.explanation, args.goal),
    );
const confirmationMessages = shouldShowConfirmation
  ? {
      title: confirmationTitle,
      message: confirmationMessage,
      disclaimer,
      allowAutoConfirm: undefined,
      terminalCustomActions: customActions,
    }
  : undefined;
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- Symbol: `RunInTerminalTool.prepareToolInvocation`
- Approx lines: `852-880`

## 2. Auto-Approval Must Be Explicitly Enabled and Opted Into

### Why

Auto-running shell commands is inherently risky. Core requires both a feature toggle and a separate accepted-warning state before auto-approval becomes active.

### Expected Behavior

- A setting should control whether auto-approval is even possible.
- A stored "warning accepted" state should also be required.
- Disabling auto-approval should clear the acceptance state.

### Third-Party Extension Guidance

Use two gates:

1. `enableAutoApprove`
2. `userAcceptedAutoApproveWarning`

Never treat matching an allow-rule as sufficient on its own.

### Current Core Note

Current core still follows this pattern for terminal-specific auto-approval.

There are also broader approval paths that sit above terminal-specific rule evaluation:

- session permission levels such as Autopilot and Bypass Approvals can auto-approve all tool calls for a chat session
- the global `chat.tools.global.autoApprove` setting has its own opt-in dialog and can suppress confirmation outside the terminal-specific rule engine

When comparing behavior, distinguish these paths. A command can skip confirmation even when terminal auto-approval rules did not approve it.

### Current Extension Note

This extension no longer follows that exact pattern. Instead, it requires a per-invocation `riskAssessment`, optionally loads `riskAssessmentContext` files and inline sub-action notes for model review, applies explicit `allow`/`ask`/`deny` rules first, short-circuits unresolved commands through the YOLO override if enabled, and otherwise consults a configured chat model for unresolved commands. Risk-assessment failures or timeouts fall back to explicit approval.

### Core Reference Snippet

```ts
const isEligible = isToolEligibleForTerminalAutoApproval(
  toolReferenceName,
  configurationService,
  legacyToolReferenceFullNames,
);
const isAutoApproveEnabled = configurationService.getValue(TerminalChatAgentToolsSettingId.EnableAutoApprove) === true;
const isAutoApproveWarningAccepted = storageService.getBoolean(
  TerminalToolConfirmationStorageKeys.TerminalAutoApproveWarningAccepted,
  StorageScope.APPLICATION,
  false,
);
return isEligible && isAutoApproveEnabled && isAutoApproveWarningAccepted;
```

```ts
this._register(
  Event.runAndSubscribe(this._configurationService.onDidChangeConfiguration, e => {
    if (!e || e.affectsConfiguration(TerminalChatAgentToolsSettingId.EnableAutoApprove)) {
      if (this._configurationService.getValue(TerminalChatAgentToolsSettingId.EnableAutoApprove) !== true) {
        this._storageService.remove(
          TerminalToolConfirmationStorageKeys.TerminalAutoApproveWarningAccepted,
          StorageScope.APPLICATION,
        );
      }
    }
  }),
);
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/terminalToolAutoApprove.ts`
- Symbol: `isTerminalAutoApproveAllowed`
- Approx lines: `58-73`
- Symbol: `RunInTerminalTool` constructor warning reset logic
- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- Approx lines: `555-561`

### Related Current Core Markers

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/terminalToolAutoApprove.ts`
- Symbol: `isSessionAutoApproveLevel`
- Approx lines: `18-40`
- File: `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts`
- Symbol: `LanguageModelToolsService._checkGlobalAutoApprove`
- Approx lines: `1189-1263`

## 3. Default Allowlist and Denylist Rules for Commands

### Why

The command line is too broad to safely auto-run by default. Core narrows the safe set to common read-only commands and explicitly denies common destructive or high-risk commands.

### Expected Behavior

- Read-only commands can be auto-approvable.
- Safe subcommands and narrowly scoped package-manager commands can also be auto-approvable.
- Destructive commands should remain pending approval.
- Some commands should be allowed generally but denied with specific risky flags.

### Third-Party Extension Guidance

Ship a built-in default ruleset, but allow users and workspaces to override it.

At minimum, keep the following denied unless explicitly approved:

- deletion commands
- process kill/control commands
- web fetchers
- permission/ownership commands
- general execution helpers like `eval`

### Core Reference Snippet

```ts
// Generally safe commands
cd: true,
echo: true,
ls: true,
pwd: true,
cat: true,

// Safe git subcommands
'/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+status\\b/': true,
'/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+log\\b/': true,
'/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+show\\b/': true,
'/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+diff\\b/': true,

// Safe docker and package-manager reads
'/^docker\\s+(ps|images|info|version|inspect|logs)\\b/': true,
'/^npm\\s+(ls|list|outdated|view|info|show|explain|why)\\b/': true,
'npm ci': true,

// Deleting files
rm: false,
rmdir: false,
del: false,
'Remove-Item': false,
ri: false,
rd: false,
erase: false,
dd: false,

// Managing/killing processes, dangerous thing to do generally
kill: false,
ps: false,
top: false,
'Stop-Process': false,
spps: false,
taskkill: false,
'taskkill.exe': false,

// Web requests, prompt injection concerns
curl: false,
wget: false,
'Invoke-RestMethod': false,
'Invoke-WebRequest': false,
'irm': false,
'iwr': false,

// File permissions and ownership, messing with these can cause hard to diagnose issues
chmod: false,
chown: false,
'Set-ItemProperty': false,
'sp': false,
'Set-Acl': false,

// General eval/command execution, can lead to anything else running
jq: false,
xargs: false,
eval: false,
'Invoke-Expression': false,
iex: false,
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalChatAgentToolsConfiguration.ts`
- Symbol: `terminalChatAgentToolsConfiguration[TerminalChatAgentToolsSettingId.AutoApprove]`
- Approx lines: `91-434`

## 4. Deny Dangerous Variants of Otherwise Safe Commands

### Why

Some commands are only safe in a narrow form. For example, `find` can be read-only or it can delete and execute arbitrary commands.

### Expected Behavior

- Allow common read-only forms.
- Deny risky flags and subcommand forms.
- Treat matching as a security policy, not just a UX convenience.

### Third-Party Extension Guidance

Design your allowlist around exact intent, not command names. Prefer specific regex rules over broad allow patterns.

### Core Reference Snippet

```ts
// find
// - `-delete`: Deletes files or directories.
// - `-exec`/`-execdir`: Execute on results.
// - `-fprint`/`fprintf`/`fls`: Writes files.
// - `-ok`/`-okdir`: Like exec but with a confirmation.
find: true,
'/^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/': false,

// rg (ripgrep)
// - `--pre`: Executes arbitrary command as preprocessor for every file searched.
// - `--hostname-bin`: Executes arbitrary command to get hostname.
rg: true,
'/^rg\\b.*\\s(--pre|--hostname-bin)\\b/': false,

// sed
sed: true,
'/^sed\\b.*\\s(-[a-zA-Z]*(e|f)[a-zA-Z]*|--expression|--file)\\b/': false,
'/^sed\\b.*s\\/.*\\/.*\\/[ew]/': false,
'/^sed\\b.*;W/': false,
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalChatAgentToolsConfiguration.ts`
- Symbol: default `AutoApprove` rules
- Approx lines: `287-389`

## 5. Parse Every Subcommand, Not Just the Whole String

### Why

`safe && dangerous` must not become safe just because the first token looked harmless. Core parses subcommands and makes approval decisions across the whole command line.

### Expected Behavior

- Parse the command line into subcommands.
- Require that all relevant subcommands pass approval.
- If any subcommand is explicitly denied, the whole invocation is not auto-approved.

### Third-Party Extension Guidance

Use a shell parser if you can. If you cannot, use a conservative parser and fail closed.

### Core Reference Snippet

```ts
let subCommands: string[] | undefined;
try {
  subCommands = await this._treeSitterCommandParser.extractSubCommands(options.treeSitterLanguage, trimmedCommandLine);
  this._log(`Parsed sub-commands via ${options.treeSitterLanguage} grammar`, subCommands);
} catch (e) {
  console.error(e);
  this._log(`Failed to parse sub-commands via ${options.treeSitterLanguage} grammar`);
}

const subCommandResults = await Promise.all(
  subCommands.map(e =>
    this._commandLineAutoApprover.isCommandAutoApproved(
      e,
      options.shell,
      options.os,
      options.cwd,
      options.chatSessionResource,
    ),
  ),
);
const commandLineResult = this._commandLineAutoApprover.isCommandLineAutoApproved(
  trimmedCommandLine,
  options.chatSessionResource,
);
```

```ts
const deniedSubCommandResult = subCommandResults.find(e => e.result === 'denied');
if (deniedSubCommandResult) {
  this._log('Sub-command DENIED auto approval');
  isDenied = true;
} else if (commandLineResult.result === 'denied') {
  this._log('Command line DENIED auto approval');
  isDenied = true;
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineAutoApproveAnalyzer.ts`
- Symbol: `CommandLineAutoApproveAnalyzer.analyze`
- Approx lines: `73-146`

## 6. Deny Transient Environment Variable Prefixes

### Why

Commands like `FOO=bar cmd` can radically alter execution and are hard to reason about from policy alone.

### Expected Behavior

- Deny auto-approval for commands that begin with transient environment assignments.
- Require manual confirmation instead.

### Third-Party Extension Guidance

Fail closed. This is a cheap, high-value rule that avoids surprising behavior.

### Current Extension Divergence Note

This extension intentionally diverges from the core behavior above.

Compared with core's blanket denial, the extension keeps the same fail-closed posture for ambiguous prefixes and for explicit `ask` or `deny` matches, but it does not force an automatic manual prompt for every unambiguous transient-prefix command.

When a command begins with transient environment assignments, it strips those leading assignments before evaluating approval rules:

- matching `deny` and `ask` rules are preserved
- matching `allow` rules are ignored instead of auto-running the command
- unresolved commands still go through model-based risk assessment unless the user has enabled the explicit YOLO override
- if risk assessment is disabled, times out, errors, or explicitly requests review, the command falls back to manual approval

This keeps transient prefixes from silently inheriting an `allow` rule while avoiding a blanket manual-confirmation requirement for every such command.

### Core Reference Snippet

```ts
const transientEnvVarRegex = /^[A-Z_][A-Z0-9_]*=/i;

async isCommandAutoApproved(command: string, shell: string, os: OperatingSystem, cwd: URI | undefined, chatSessionResource?: URI): Promise<ICommandApprovalResultWithReason> {
 // Check if the command has a transient environment variable assignment prefix which we
 // always deny for now as it can easily lead to execute other commands
 if (transientEnvVarRegex.test(command)) {
  return {
   result: 'denied',
   reason: `Command '${command}' is denied because it contains transient environment variables`
  };
 }
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/autoApprove/commandLineAutoApprover.ts`
- Symbol: `CommandLineAutoApprover.isCommandAutoApproved`
- Approx lines: `27-41`, `80-88`

## 7. File-Write Detection Must Escalate Approval

### Why

Writes are materially higher risk than reads, especially outside the workspace or when the target path is unclear.

### Expected Behavior

- Detect redirections and in-place edits.
- If writes are outside the workspace, disable auto-approval.
- If cwd is unknown or the path contains variables/subcommands, disable auto-approval.
- Surface a disclaimer telling the user what was detected.

### Third-Party Extension Guidance

If you cannot parse all writes, still parse the high-value ones:

- `>` / `>>`
- PowerShell redirection
- `sed -i`

Fail closed when the target path is ambiguous.

### Current Extension Divergence Note

This extension intentionally implements a narrower file-write policy than core.

It detects output redirections conservatively during approval parsing, but it does not use file-write location analysis to force a dedicated approval outcome.

When a command includes a detected file-target output redirection:

- matching `deny` and `ask` rules are preserved
- matching `allow` rules are ignored instead of auto-running the command
- unresolved commands continue through model-based risk assessment unless the YOLO override is enabled
- if risk assessment is disabled, times out, errors, or requests review, the command falls back to explicit approval

Descriptor duplication such as `2>&1` stays eligible for normal rule matching; only redirections that still target a file path after conservative parsing suppress `allow`.

### Core Reference Snippet

```ts
const blockDetectedFileWrites = this._configurationService.getValue<string>(
  TerminalChatAgentToolsSettingId.BlockDetectedFileWrites,
);
switch (blockDetectedFileWrites) {
  case 'all': {
    isAutoApproveAllowed = false;
    this._log('File writes blocked due to "all" setting');
    break;
  }
  case 'outsideWorkspace': {
    const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
    if (workspaceFolders.length > 0) {
      for (const fileWrite of fileWrites) {
        if (fileWrite === nullDevice) {
          this._log('File write to null device allowed', URI.isUri(fileWrite) ? fileWrite.toString() : fileWrite);
          continue;
        }

        if (isString(fileWrite)) {
          const isAbsolute =
            options.os === OperatingSystem.Windows ? win32.isAbsolute(fileWrite) : posix.isAbsolute(fileWrite);
          if (!isAbsolute) {
            isAutoApproveAllowed = false;
            this._log('File write blocked due to unknown terminal cwd', fileWrite);
            break;
          }
        }
        const fileUri = URI.isUri(fileWrite) ? fileWrite : URI.file(fileWrite);
        if (fileUri.fsPath.match(/[$\(\){}`]/)) {
          isAutoApproveAllowed = false;
          this._log('File write blocked due to likely containing a variable or sub-command', fileUri.toString());
          break;
        }

        const isInsideWorkspace = workspaceFolders.some(
          folder =>
            folder.uri.scheme === fileUri.scheme &&
            (fileUri.path.startsWith(folder.uri.path + '/') || fileUri.path === folder.uri.path),
        );
        if (!isInsideWorkspace) {
          isAutoApproveAllowed = false;
          this._log('File write blocked outside workspace', fileUri.toString());
          break;
        }
      }
    }
    break;
  }
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineFileWriteAnalyzer.ts`
- Symbol: `CommandLineFileWriteAnalyzer._getResult`
- Approx lines: `119-190`

## 8. Workspace-Only Package Script Auto-Approval

### Why

Core makes a narrow exception for package scripts because they are already declared in workspace configuration and are easier to reason about than arbitrary shell text.

### Expected Behavior

- Only auto-approve scripts defined in a workspace `package.json`.
- In current core, only check `cwd/package.json` within the workspace.
- Do not search outside the workspace.
- Require the feature to be separately enabled.

### Third-Party Extension Guidance

This is a good narrow convenience path if your extension works primarily in JS/TS repos. Restrict it to workspace-local `package.json` files.

### Current Extension Divergence Note

This extension intentionally does not implement workspace-only package-script auto-approval.

Instead, callers should pass the relevant `package.json` script definitions, alias expansions, or referenced helper files through `riskAssessmentContext` so the risk-assessment model can review what the command will actually run.

The prompt used for model-based risk assessment is explicitly instructed to request manual confirmation when script-related context is missing or insufficient to evaluate the command safely.

### Core Reference Snippet

```ts
async isCommandAutoApproved(command: string, cwd: URI | undefined): Promise<INpmScriptAutoApproveResult> {
 // Check if the feature is enabled
 const isNpmScriptAutoApproveEnabled = this._configurationService.getValue(TerminalChatAgentToolsSettingId.AutoApproveWorkspaceNpmScripts) === true;
 if (!isNpmScriptAutoApproveEnabled) {
  return { isAutoApproved: false };
 }

 // Extract script name from the command
 const scriptName = this._extractScriptName(command);
 if (!scriptName) {
  return { isAutoApproved: false };
 }

 // Find and parse package.json
 const packageJsonScripts = await this._getPackageJsonScripts(cwd);
 if (!packageJsonScripts) {
  return { isAutoApproved: false };
 }

 // Check if script exists in package.json
 if (!packageJsonScripts.scripts.has(scriptName)) {
  return { isAutoApproved: false };
 }

 // Script exists - auto approve
 return {
  isAutoApproved: true,
  scriptName,
  autoApproveInfo: new MarkdownString(
   localize('autoApprove.npmScript', 'Auto approved as {0} is defined in package.json', `\`${scriptName}\``)
  ),
 };
}
```

```ts
private async _getPackageJsonScripts(cwd: URI | undefined): Promise<IPackageJsonScripts | undefined> {
 // Only look in cwd if it's within the workspace
 if (!cwd || !this._isWithinWorkspace(cwd)) {
  return undefined;
 }
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/autoApprove/npmScriptAutoApprover.ts`
- Symbol: `NpmScriptAutoApprover.isCommandAutoApproved`
- Approx lines: `92-123`
- Symbol: `NpmScriptAutoApprover._getPackageJsonScripts`
- Approx lines: `160-168`

## 9. Warn on Web Fetchers Because of Prompt Injection Risk

### Why

Commands that fetch remote content can return hostile text that tries to manipulate the model. Core treats this as a separate concern from execution safety and adds a disclaimer.

### Expected Behavior

- Detect common fetchers like `curl`, `wget`, `Invoke-WebRequest`, `Invoke-RestMethod`.
- Add a disclaimer when they are not already auto-approved.
- Do not rely on this warning alone; pair it with deny-by-default or manual approval.

### Third-Party Extension Guidance

Implement this even if you cannot implement the full rule system. This warning has strong security value and low implementation cost.

### Current Extension Divergence Note

This extension does not emit a separate user-facing disclaimer for web fetchers.

Instead:

- default deny rules already cover common fetchers such as `curl`, `wget`, `Invoke-WebRequest`, and `Invoke-RestMethod`
- the risk-assessment prompt explicitly asks the model to look for fetched-content, prompt-injection, and script-injection hazards
- missing fetched-content context or missing script details are treated as reasons to request manual confirmation

### Core Reference Snippet

```ts
const promptInjectionWarningCommandsLower = ['curl', 'wget'];
const promptInjectionWarningCommandsLowerPwshOnly = ['invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr'];
```

```ts
if (
  !isAutoApproved &&
  (subCommandsLowerFirstWordOnly.some(command => promptInjectionWarningCommandsLower.includes(command)) ||
    (isPowerShell(options.shell, options.os) &&
      subCommandsLowerFirstWordOnly.some(command => promptInjectionWarningCommandsLowerPwshOnly.includes(command))))
) {
  disclaimers.push(
    localize(
      'runInTerminal.promptInjectionDisclaimer',
      'Web content may contain malicious code or attempt prompt injection attacks.',
    ),
  );
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineAutoApproveAnalyzer.ts`
- Symbol: module constants and `analyze`
- Approx lines: `26-34`, `177-181`

## Sandboxing Status in This Extension

Sections 10-16 below describe the current VS Code core sandbox model.

This extension does not currently implement sandbox wrapping, sandbox-aware unsandbox retry paths, sandbox domain or filesystem policy enforcement, or sandbox-specific failure analysis.

That is intentional for now. In this extension's current spawned-shell workflow, these controls would be counter-productive for many expected commands and would add significant friction for limited practical benefit. They may be revisited if the runtime model changes or if the command mix materially shifts.

## 10. Sandbox Wrapping Should Be the Strongest Runtime Guard

### Why

Approval logic only protects the pre-execution phase. Sandbox wrapping is what can actually constrain a command at runtime.

### Expected Behavior

- If sandboxing is enabled, check prerequisites before wrapping.
- If sandbox dependencies are missing, interrupt execution with a dedicated install flow.
- If sandboxing proceeds, wrap the command before execution.
- Preserve the original command for display.
- Mark the invocation as sandbox-wrapped so downstream UI and output analysis know it was contained.
- Surface blocked domains and whether the command was forced onto an unsandboxed-confirmation path.

### Third-Party Extension Guidance

If you can use an OS-level sandbox, do it. If you cannot, document that your extension is offering approval controls, not runtime isolation. If you do support sandboxing, handle missing prerequisites and pre-execution blocked-domain escalation explicitly.

### Current Extension Note

Not implemented for now. This extension currently relies on approval controls and spawned-shell execution rather than runtime sandboxing, and introducing sandbox wrapping in the current workflow would be counter-productive for many expected commands. This may be revisited later.

### Core Reference Snippet

```ts
async rewrite(options: ICommandLineRewriterOptions): Promise<ICommandLineRewriterResult | undefined> {
 const sandboxPrereqs = await this._sandboxService.checkForSandboxingPrereqs();
 if (!sandboxPrereqs.enabled || sandboxPrereqs.failedCheck === TerminalSandboxPrerequisiteCheck.Config) {
  return undefined;
 }

 const wrappedCommand = this._sandboxService.wrapCommand(
  options.commandLine,
  options.requestUnsandboxedExecution,
  options.shell,
 );
 return {
  rewritten: wrappedCommand.command,
  reasoning: wrappedCommand.requiresUnsandboxConfirmation
   ? 'Switched command to unsandboxed execution because the command includes a domain that is not in the sandbox allowlist'
   : 'Wrapped command for sandbox execution',
  forDisplay: options.commandLine,
  isSandboxWrapped: wrappedCommand.isSandboxWrapped,
  requiresUnsandboxConfirmation: wrappedCommand.requiresUnsandboxConfirmation,
  blockedDomains: wrappedCommand.blockedDomains,
  deniedDomains: wrappedCommand.deniedDomains,
 };
}
```

```ts
const missingDependencies =
  sandboxPrereqs.failedCheck === TerminalSandboxPrerequisiteCheck.Dependencies &&
  sandboxPrereqs.missingDependencies?.length
    ? sandboxPrereqs.missingDependencies
    : undefined;

if (missingDependencies) {
  sandboxConfirmationMessageForMissingDeps = {
    title: localize('runInTerminal.missingDeps.title', 'Missing Sandbox Dependencies'),
    message: new MarkdownString(
      localize(
        'runInTerminal.missingDeps.message',
        'The following dependencies required for sandboxed execution are not installed: {0}. Would you like to install them?',
        missingDependencies.join(', '),
      ),
    ),
    customButtons: [
      localize('runInTerminal.missingDeps.install', 'Install'),
      localize('runInTerminal.missingDeps.cancel', 'Cancel'),
    ],
  };
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineRewriter/commandLineSandboxRewriter.ts`
- Symbol: `CommandLineSandboxRewriter.rewrite`
- Approx lines: `14-30`
- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- Symbol: `RunInTerminalTool.prepareToolInvocation` missing dependency confirmation path
- Approx lines: `623-691`

## 11. Quote the Wrapped Command Before Passing It to the Sandbox Runtime

### Why

If you embed the user command inside an outer wrapper shell invocation, quoting is part of the security boundary. The wrapper itself must not become a shell-injection vector.

### Expected Behavior

- Quote the original command before embedding it into the outer wrapper.
- Treat quoting as mandatory, not optional.

### Third-Party Extension Guidance

Mirror this exactly if you use a shell-based wrapper. In current core, the same quoting helper is also used when the sandbox path falls back to an unsandboxed shell wrapper that preserves `TMPDIR`.

### Current Extension Note

Not implemented for now. Because this extension does not currently wrap commands in a sandbox runtime, there is no sandbox-wrapper quoting path to mirror at this time. This may be revisited later if sandbox execution is introduced.

### Core Reference Snippet

```ts
private _quoteShellArgument(value: string): string {
 return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

```ts
const wrappedCommand = `PATH="$PATH:${dirname(this._rgPath)}" TMPDIR="${this._tempDir.path}" CLAUDE_TMPDIR="${this._tempDir.path}" "${this._execPath}" "${this._srtPath}" --settings "${this._sandboxConfigPath}" -c ${this._quoteShellArgument(command)}`;
return `env TMPDIR="${this._tempDir.path}" ${this._quoteShellArgument(shell)} -c ${this._quoteShellArgument(command)}`;
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalSandboxService.ts`
- Symbol: `TerminalSandboxService._quoteShellArgument`
- Approx lines: `459-461`
- Symbol: `TerminalSandboxService.wrapCommand`
- Approx lines: `210-251`
- Symbol: `TerminalSandboxService._wrapUnsandboxedCommand`
- Approx lines: `463-470`

## 12. Unsandboxed Execution Must Require Stronger Confirmation and a Reason

### Why

Leaving the sandbox is a security-sensitive state transition. It needs more than a normal run confirmation.

### Expected Behavior

- Require a distinct boolean like `requestUnsandboxedExecution`.
- Require an explanation string.
- Show a special confirmation title and message.
- Support both explicit unsandbox requests and policy-detected unsandbox confirmations, such as blocked domains discovered in the command text.

### Third-Party Extension Guidance

Do not hide this behind a silent retry. Make it explicit in both tool parameters and UI. If your policy engine can infer that a command needs to leave containment, surface that as the same elevated confirmation path.

### Current Extension Note

Not implemented for now. This extension has no sandbox-to-unsandbox transition flow because it does not currently run commands inside a sandbox. Adding that state machine in the current workflow would be counter-productive for many expected commands. This may be revisited later.

### Core Reference Snippet

```ts
    ...isSandboxEnabled ? {
     requestUnsandboxedExecution: {
      type: 'boolean',
      description: 'Request that this command run outside the terminal sandbox. Only set this after first executing the command in sandbox and observing that sandboxing caused the failure. The user will be prompted before the command runs unsandboxed.'
     },
     requestUnsandboxedExecutionReason: {
      type: 'string',
      description: 'A short explanation of the sandboxed execution failure or blocked-domain requirement that justifies retrying outside the sandbox. Only provide this when requestUnsandboxedExecution is true.'
     },
    } : {},
```

```ts
if (requiresUnsandboxConfirmation) {
  confirmationTitle = blockedDomains?.length
    ? localize(
        'runInTerminal.unsandboxed.domain',
        'Run `{0}` command outside the [sandbox]({1}) to access {2}?',
        shellType,
        TERMINAL_SANDBOX_DOCUMENTATION_URL,
        this._formatBlockedDomainsForTitle(blockedDomains),
      )
    : localize(
        'runInTerminal.unsandboxed',
        'Run `{0}` command outside the [sandbox]({1})?',
        shellType,
        TERMINAL_SANDBOX_DOCUMENTATION_URL,
      );
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- Symbol: `createRunInTerminalToolData`
- Approx lines: `294-304`
- Symbol: `RunInTerminalTool.prepareToolInvocation`
- Approx lines: `844-847`

## 13. Sandbox Network Policy Should Be Allowlist/Denylist Based

### Why

Remote network access is often the highest-risk side effect for shell tools. Core uses a sandbox config where denied domains take precedence and allowed domains default to empty.

### Expected Behavior

- Separate allowed and denied lists.
- Denied domains should override allowed domains.
- An empty allowlist should mean no network access.
- Detect obvious network domains in the command text and escalate to unsandbox confirmation when they are denied or not allowed.

### Third-Party Extension Guidance

If your runtime supports domain filtering, mirror this structure exactly. If it does not, at least parse obvious URLs, SSH remotes, and host-like arguments before execution so you can prompt or deny before the command runs.

### Current Extension Note

Not implemented for now. This extension does not currently enforce sandbox network allowlists or denylists because it does not ship a sandboxed execution runtime. That tradeoff is intentional in the current workflow and may be revisited later.

### Core Reference Snippet

```ts
const sandboxSettings = {
  network: {
    allowedDomains: allowedDomainsSetting,
    deniedDomains: deniedDomainsSetting,
  },
  filesystem: {
    denyRead: this._os === OperatingSystem.Macintosh ? macFileSystemSetting.denyRead : linuxFileSystemSetting.denyRead,
    allowWrite: this._os === OperatingSystem.Macintosh ? macAllowWrite : linuxAllowWrite,
    denyWrite:
      this._os === OperatingSystem.Macintosh ? macFileSystemSetting.denyWrite : linuxFileSystemSetting.denyWrite,
  },
};
```

```ts
public getResolvedNetworkDomains(): ITerminalSandboxResolvedNetworkDomains {
 const allowedDomains = this._getSettingValue<string[]>(TerminalChatAgentToolsSettingId.AgentSandboxNetworkAllowedDomains, TerminalChatAgentToolsSettingId.DeprecatedAgentSandboxNetworkAllowedDomains) ?? [];
 const deniedDomains = this._getSettingValue<string[]>(TerminalChatAgentToolsSettingId.AgentSandboxNetworkDeniedDomains, TerminalChatAgentToolsSettingId.DeprecatedAgentSandboxNetworkDeniedDomains) ?? [];
 return {
  allowedDomains,
  deniedDomains
 };
}
```

```ts
private _getBlockedDomains(command: string): { blockedDomains: string[]; deniedDomains: string[] } {
 const domains = this._extractDomains(command);
 if (domains.length === 0) {
  return { blockedDomains: [], deniedDomains: [] };
 }

 const { allowedDomains, deniedDomains } = this.getResolvedNetworkDomains();
 const blockedDomains = new Set<string>();
 const explicitlyDeniedDomains = new Set<string>();
 for (const domain of domains) {
  if (deniedDomains.some(pattern => this._matchesDomainPattern(domain, pattern))) {
   blockedDomains.add(domain);
   explicitlyDeniedDomains.add(domain);
   continue;
  }
  if (!allowedDomains.some(pattern => this._matchesDomainPattern(domain, pattern))) {
   blockedDomains.add(domain);
  }
 }
 return {
  blockedDomains: [...blockedDomains],
  deniedDomains: [...explicitlyDeniedDomains],
 };
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalSandboxService.ts`
- Symbol: `TerminalSandboxService._createSandboxConfig`
- Approx lines: `641-668`
- Symbol: `TerminalSandboxService.getResolvedNetworkDomains`
- Approx lines: `731-737`
- Symbol: `TerminalSandboxService._getBlockedDomains`
- Approx lines: `473-494`

## 14. Sandbox Filesystem Policy Should Default to Workspace-Scoped Writes

### Why

The shell tool often needs to write within the workspace, but unrestricted writes are too dangerous. Core narrows writes to workspace folders plus a small set of operational paths.

### Expected Behavior

- Support `denyRead`, `allowWrite`, and `denyWrite`.
- Add workspace folders into the effective `allowWrite` set.
- Preserve configured extra write paths.
- Keep a dedicated sandbox temp directory available.

### Third-Party Extension Guidance

If your sandbox supports only allow-write paths, start there. The important behavior is that the workspace is allowed and everything else is denied unless explicitly opened.

### Current Extension Note

Not implemented for now. This extension does not currently enforce sandbox filesystem policy because it does not run commands inside a sandbox. Adding those constraints in the current workflow would be counter-productive for many expected commands. This may be revisited later.

### Core Reference Snippet

```ts
private _updateAllowWritePathsWithWorkspaceFolders(configuredAllowWrite: string[] | undefined): string[] {
 const workspaceFolderPaths = this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri.path);
 return [...new Set([...workspaceFolderPaths, ...this._defaultWritePaths, ...(configuredAllowWrite ?? [])])];
}
```

```ts
private _defaultWritePaths: string[] = ['~/.npm'];
```

```ts
if (this._tempDir) {
  this._defaultWritePaths.push(this._tempDir.path);
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalSandboxService.ts`
- Symbol: `_defaultWritePaths`
- Approx lines: `133-133`
- Symbol: `_initTempDir`
- Approx lines: `683-691`
- Symbol: `_updateAllowWritePathsWithWorkspaceFolders`
- Approx lines: `740-742`

## 15. Sandbox Mode Should Auto-Approve Only the Sandboxed Path, Not the Escape Hatch

### Why

If the command is running inside containment, core allows that path to proceed more freely. If the command requests unsandboxed execution, that special path must not inherit the same approval behavior.

### Expected Behavior

- If sandboxing is enabled and the command stays sandboxed, the analyzer may force auto-approval.
- If the command requests unsandboxed execution, do not force auto-approval.

### Third-Party Extension Guidance

This is a useful pattern if your sandbox is strong enough to justify lower confirmation friction for contained commands.

### Current Extension Note

Not implemented for now. Because this extension does not currently execute commands in a sandbox, it has no sandbox-only auto-approval path and no separate escape-hatch treatment to model here. This may be revisited later.

### Core Reference Snippet

```ts
async analyze(_options: ICommandLineAnalyzerOptions): Promise<ICommandLineAnalyzerResult> {
 if (!(await this._sandboxService.isEnabled())) {
  return {
   isAutoApproveAllowed: true,
  };
 }
 return {
  isAutoApproveAllowed: true,
  forceAutoApproval: _options.requiresUnsandboxConfirmation ? false : true,
 };
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineSandboxAnalyzer.ts`
- Symbol: `CommandLineSandboxAnalyzer.analyze`
- Approx lines: `12-24`

## 16. Detect Sandbox Failures and Steer the Retry Path

### Why

When a command fails due to sandbox restrictions, the model should not keep blindly retrying the same blocked action.

### Expected Behavior

- Detect common sandbox-denied output strings.
- Tell the model to either adjust sandbox rules or request unsandboxed execution.
- Do not ask the user twice for the same concept; the unsandboxed flag should trigger the confirmation flow.

### Third-Party Extension Guidance

If you have a sandbox, you also need sandbox-specific failure handling. Otherwise the model will thrash on denied actions.

### Current Extension Note

Not implemented for now. This extension does not currently analyze output for sandbox-specific failures because it does not run commands in a sandboxed mode. This may be revisited later if sandboxing is introduced.

### Core Reference Snippet

```ts
const prefix = knownFailure
  ? 'Command failed while running in sandboxed mode. If the command failed due to sandboxing:'
  : 'Command ran in sandboxed mode and may have been blocked by the sandbox. If the command failed due to sandboxing:';
return `${prefix}
- If it would be reasonable to extend the sandbox rules, work with the user to update allowWrite for file system access problems in ${fileSystemSetting}, or to add required domains to ${TerminalChatAgentToolsSettingId.AgentSandboxNetworkAllowedDomains}.
- Otherwise, immediately retry the command with requestUnsandboxedExecution=true. Do NOT ask the user — setting this flag automatically shows a confirmation prompt to the user.

Here is the output of the command:\n`;
```

```ts
return /Operation not permitted|Permission denied|Read-only file system|sandbox-exec|bwrap|sandbox_violation/i.test(
  normalized,
);
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/sandboxOutputAnalyzer.ts`
- Symbol: `SandboxOutputAnalyzer.analyze`
- Approx lines: `19-42`
- Symbol: `outputLooksSandboxBlocked`
- Approx lines: `59-61`

## 17. Exclude Tool Commands from Shell History

### Why

Command history becomes a leakage path for secrets, one-off operational commands, and model-generated content.

### Expected Behavior

- Set shell-specific environment wiring for history suppression.
- Rewrite commands where required, such as prepending a space for bash/zsh.

### Third-Party Extension Guidance

Replicate both parts:

1. terminal environment setup
2. command rewriting

Only doing one of them is incomplete.

### Current Extension Note

Not directly applicable in the current implementation. This extension runs shell tools through spawned non-interactive shells rather than a tool-owned interactive terminal with shell integration, so the core `VSCODE_PREVENT_SHELL_HISTORY` wiring and leading-space rewrite do not map cleanly to this runtime.

In practice, the more relevant local persistence surface here is the extension's own temporary shell metadata and output store, not the user's interactive shell history. If the runtime later moves toward integrated interactive terminals, this section should be revisited.

### Core Reference Snippet

```ts
const preventShellHistory =
  this._configurationService.getValue(TerminalChatAgentToolsSettingId.PreventShellHistory) === true;
if (preventShellHistory) {
  // Check if the shell supports history exclusion via shell integration scripts
  if (isBash(shellPath, os) || isZsh(shellPath, os) || isFish(shellPath, os) || isPowerShell(shellPath, os)) {
    env['VSCODE_PREVENT_SHELL_HISTORY'] = '1';
  }
}
```

```ts
rewrite(options: ICommandLineRewriterOptions): ICommandLineRewriterResult | undefined {
 const preventShellHistory = this._configurationService.getValue(TerminalChatAgentToolsSettingId.PreventShellHistory) === true;
 if (!preventShellHistory) {
  return undefined;
 }
 // Only bash and zsh use space prefix to exclude from history
 if (isBash(options.shell, options.os) || isZsh(options.shell, options.os)) {
  return {
   rewritten: ` ${options.commandLine}`,
   reasoning: 'Prepended with a space to exclude from shell history'
  };
 }
 return undefined;
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts`
- Symbol: `ToolTerminalCreator._createCopilotTerminal`
- Approx lines: `145-169`
- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineRewriter/commandLinePreventHistoryRewriter.ts`
- Symbol: `CommandLinePreventHistoryRewriter.rewrite`
- Approx lines: `23-34`

## 18. Harden the Terminal Environment for Non-Interactive Git Behavior

### Why

Some terminal operations become risky or disruptive when they unexpectedly open an editor or pager. Core neutralizes several Git behaviors for tool-driven terminals.

### Expected Behavior

- Disable interactive Git pagers.
- Prevent merge and editor prompts from stealing control flow.

### Third-Party Extension Guidance

This is not a primary security control, but it is worthwhile. Tool-driven terminals should be deterministic and non-interactive by default.

### Core Reference Snippet

```ts
const env: Record<string, string> = {
  // Avoid making `git diff` interactive when called from copilot
  GIT_PAGER: 'cat',
  // Prevent git from opening an editor for merge commits
  GIT_MERGE_AUTOEDIT: 'no',
  // Prevent git from opening an editor (e.g. for commit --amend, rebase -i).
  // `:` is a POSIX shell built-in no-op (returns 0), works cross-platform
  // since git always invokes the editor via `sh -c`.
  GIT_EDITOR: ':',
};
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts`
- Symbol: `ToolTerminalCreator._createCopilotTerminal`
- Approx lines: `149-155`

## 19. Sanitize and Truncate Output Before Returning It to the Model

### Why

This is not a secrets scanner, but it does reduce accidental leakage and context overflow. ANSI escapes are also unsafe to preserve as raw content.

### Expected Behavior

- Strip ANSI escape codes.
- Trim trailing line noise.
- Truncate output to a hard limit.
- Prefer keeping the tail, since the final lines often contain the error.

### Third-Party Extension Guidance

Adopt the same pipeline even if your transport differs.

### Current Extension Note

Implemented with a different boundary than core. This extension preserves display-oriented ANSI SGR styling in normalized runtime output so the Shell Runs panel can retain colors and formatting, but it strips non-display terminal control sequences during normalization and strips all remaining control sequences before output is returned in LM tool results.

That means ANSI styling is retained for the Shell Runs panel, but not for model-visible tool output.

### Core Reference Snippet

```ts
const MAX_OUTPUT_LENGTH = 60000; // ~60KB limit to keep context manageable
export const TRUNCATION_MESSAGE = '\n\n[... PREVIOUS OUTPUT TRUNCATED ...]\n\n';
```

```ts
export function sanitizeTerminalOutput(output: string): string {
  let sanitized = removeAnsiEscapeCodes(output)
    // Trim trailing \r\n characters
    .trimEnd();

  // Truncate if output is too long to prevent context overflow
  if (sanitized.length > MAX_OUTPUT_LENGTH) {
    sanitized = truncateOutputKeepingTail(sanitized, MAX_OUTPUT_LENGTH);
  }

  return sanitized;
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/runInTerminalHelpers.ts`
- Symbol: `sanitizeTerminalOutput`
- Approx lines: `49-78`

## 20. Sanitize Telemetry So Raw Commands Are Not Logged

### Why

Telemetry should describe behavior without storing arbitrary raw command strings.

### Expected Behavior

- Reduce commands to a safe allowlisted name where possible.
- Replace unknown commands with coarse normalized buckets.
- Store sanitized metadata, not raw commands.

### Third-Party Extension Guidance

If your extension emits telemetry about tool usage, treat command text as sensitive input.

### Current Extension Note

Not currently applicable. This extension does not currently emit remote telemetry for shell tool usage. Its current diagnostics use a local VS Code output channel rather than a telemetry pipeline. If telemetry is added later, raw command text should be treated as sensitive input and sanitized before emission.

### Core Reference Snippet

```ts
const subCommandsSanitized = state.subCommands.map(e => {
  const commandName = e.split(' ')[0];
  let sanitizedCommandName = commandName.toLowerCase();
  if (!commandAllowList.has(sanitizedCommandName)) {
    if (/^(?:[A-Z][a-z0-9]+)+(?:-(?:[A-Z][a-z0-9]+))*$/.test(commandName)) {
      sanitizedCommandName = '(unknown:pwsh)';
    } else if (/^[a-z0-9_\-\.\\\/:;]+$/i.test(commandName)) {
      const properties: string[] = [];
      if (/[a-z]/.test(commandName)) {
        properties.push('ascii_lower');
      }
      if (/[A-Z]/.test(commandName)) {
        properties.push('ascii_upper');
      }
      if (/[0-9]/.test(commandName)) {
        properties.push('numeric');
      }
      const chars: string[] = [];
      for (const c of ['.', '-', '_', '/', '\\', ':', ';']) {
        if (commandName.includes(c)) {
          chars.push(c);
        }
      }
      sanitizedCommandName = `(unknown:${properties.join(',')}:${chars.join('')})`;
    } else if (/[^\x00-\x7F]/.test(commandName)) {
      sanitizedCommandName = '(unknown:unicode)';
    } else {
      sanitizedCommandName = '(unknown)';
    }
  }
  return sanitizedCommandName;
});
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/runInTerminalToolTelemetry.ts`
- Symbol: `RunInTerminalToolTelemetry.logPrepare`
- Approx lines: `17-80`

## 21. Optional: Route Some Requests to Safer Specialized Tools Instead of the Shell

### Why

The safest shell command is the one you never run. Core has a hook for replacing some terminal requests with other tools.

### Expected Behavior

- Detect when a dedicated tool would be safer or more appropriate.
- Hide the terminal tool execution when a replacement is chosen.

### Third-Party Extension Guidance

If your extension provides both shell tools and structured tools, prefer the structured tool whenever you can satisfy the intent without a shell.

### Current Extension Note

Not currently applicable. This extension does not currently supply alternate structured tools for shell-adjacent requests, and it intentionally leaves tool selection to the agent rather than trying to override that decision inside the extension. This may be revisited in the future.

### Core Reference Snippet

```ts
const alternativeRecommendation = getRecommendedToolsOverRunInTerminal(args.command, this._languageModelToolsService);
if (alternativeRecommendation) {
  toolSpecificData.alternativeRecommendation = alternativeRecommendation;
  return {
    confirmationMessages: undefined,
    presentation: ToolInvocationPresentation.Hidden,
    toolSpecificData,
  };
}
```

### Internal Core Marker Only

- File: `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- Symbol: `RunInTerminalTool.prepareToolInvocation`
- Approx lines: `701-705`

## What Third-Party Extensions Usually Cannot Replicate Exactly

You should state these constraints clearly in your own design docs.

### Likely Not Fully Replicable via Public APIs

- core workbench confirmation UI integration at the same depth
- core shell-integration capabilities and command-detection plumbing
- internal chat permission-level and auto-approval session state
- core sandbox runtime integration
- internal telemetry classification model

### Practical Replacement Strategy

- implement your own confirmation UI
- store per-user approval state in extension storage
- keep allow/deny policy local to the extension
- use OS process isolation where available
- fail closed when parsing is ambiguous

## Minimum Viable Replication Checklist

- confirmation by default
- terminal-specific auto-approval opt-in if you support autonomous execution
- explicit approval rules with at least allow, deny, and manual-confirmation fallback behavior
- built-in deny rules for dangerous commands
- subcommand parsing
- transient env-var prefix denial
- file-write detection with outside-workspace escalation
- if you support sandboxing, prerequisite detection, blocked-domain escalation, and explicit unsandbox reasons
- prompt-injection warning for web fetchers
- output sanitization and truncation
- shell-history suppression
- telemetry sanitization

## Change-Tracking Appendix

Use this appendix to track future upstream changes. This is intentionally process-oriented so you can diff core and update the guide over time.

### Review Procedure

For each release or whenever your extension changes terminal behavior:

1. diff the internal core markers listed in each section
2. check whether behavior changed, not just code formatting
3. update the guide section
4. update your extension implementation
5. append a note below

### Suggested Tracking Table

| Area                                | Internal Core Marker                                                                                                 | Last Reviewed | Upstream Change? | Guide Updated? | Notes                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- | -------------- | ----------------------------------------------------------- |
| Confirmation gate                   | `runInTerminalTool.ts :: prepareToolInvocation`                                                                      | 2026-04-10    | Yes              | Yes            | Refreshed confirmation flow and line ranges                 |
| Terminal auto-approve gating        | `terminalToolAutoApprove.ts :: isTerminalAutoApproveAllowed`                                                         | 2026-04-10    | Yes              | Yes            | Helper split out from prepare path                          |
| Session/global auto-approve         | `terminalToolAutoApprove.ts :: isSessionAutoApproveLevel`, `languageModelToolsService.ts :: _checkGlobalAutoApprove` | 2026-04-10    | Yes              | Yes            | Added higher-level approval paths                           |
| Default policy rules                | `terminalChatAgentToolsConfiguration.ts :: AutoApprove`                                                              | 2026-04-10    | Yes              | Yes            | Built-in allowlist expanded materially                      |
| File-write analyzer                 | `commandLineFileWriteAnalyzer.ts :: _getResult`                                                                      | 2026-04-10    | Yes              | Yes            | Updated markers and outside-workspace behavior              |
| Sandbox prerequisite install flow   | `runInTerminalTool.ts :: prepareToolInvocation`                                                                      | 2026-04-10    | Yes              | Yes            | Added missing dependency confirmation path                  |
| Sandbox wrapper and blocked domains | `commandLineSandboxRewriter.ts :: rewrite`, `terminalSandboxService.ts :: wrapCommand/_getBlockedDomains`            | 2026-04-10    | Yes              | Yes            | Added blocked-domain escalation                             |
| Sandbox config                      | `terminalSandboxService.ts :: _createSandboxConfig`, `getResolvedNetworkDomains`                                     | 2026-04-10    | Yes              | Yes            | Updated setting names and removed trusted-domain merge note |
| History suppression                 | `toolTerminalCreator.ts :: _createCopilotTerminal`                                                                   | 2026-04-10    | Yes              | Yes            | Refreshed markers                                           |
| Output sanitization                 | `runInTerminalHelpers.ts :: sanitizeTerminalOutput`                                                                  | 2026-04-10    | Yes              | Yes            | Refreshed markers                                           |
| Telemetry sanitization              | `runInTerminalToolTelemetry.ts :: logPrepare`                                                                        | 2026-04-10    | Yes              | Yes            | Refreshed markers                                           |

### Suggested Upstream Diff Targets

Monitor these internal files when refreshing this guide:

- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/terminalToolAutoApprove.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineAutoApproveAnalyzer.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/autoApprove/commandLineAutoApprover.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineAnalyzer/commandLineFileWriteAnalyzer.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineRewriter/commandLineSandboxRewriter.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/commandLineRewriter/commandLinePreventHistoryRewriter.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/sandboxOutputAnalyzer.ts`
- `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/runInTerminalHelpers.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/runInTerminalToolTelemetry.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalChatAgentToolsConfiguration.ts`
- `src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalSandboxService.ts`

### Update Log

- 2026-04-10: Refreshed against commit `0e5f2c4f5c1fdb962a528d20b67a5f234bad2c08`; kept the third-party divergence notes as downstream context, updated sandbox setting names and line markers, and documented session/global auto-approve, blocked-domain escalation, and sandbox dependency install flow.
- 2026-03-24: Initial version created from current VS Code core implementation.
