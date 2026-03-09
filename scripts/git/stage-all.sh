#!/usr/bin/env bash
# stage-all.sh — Create a squashed branch from main with staged changes.
#
# Usage: ./scripts/git/stage-all.sh
#
# Flow:
#   1. Ensure working tree is clean
#   2. Resolve current branch name
#   3. Create new branch from main: staged/<current-branch>
#   4. Squash-merge current branch into the new branch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/terminal-ui.sh
source "$SCRIPT_DIR/../lib/terminal-ui.sh"

ui_set_prefix "[stage-all]"
ui_set_render_mode "task_only"
ui_init
trap 'ui_finalize' EXIT

die() {
    local message="$1"
    ui_set_live_task_state "fail" "$message"
    ui_clear_live_state
    fail "$message"
    exit 1
}

run_step() {
    local task_label="$1"
    local fail_detail="$2"
    shift 2

    ui_set_live_task_state "running" "$task_label"
    if ui_run_with_live_stdout "$@"; then
        ui_set_live_task_state "pass" "$task_label"
        ui_clear_live_state
        pass "$task_label"
        return 0
    fi

    ui_set_live_task_state "fail" "$task_label"
    ui_clear_live_state
    fail "$task_label"
    if [[ -n "$fail_detail" ]]; then
        fail "$fail_detail"
    fi
    return 1
}

ui_set_live_section_running "Create squashed branch from main"

ui_set_live_task_state "running" "Resolve current branch"
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null)" \
    || die "Not on any branch (detached HEAD?)."
ui_set_live_task_state "pass" "Resolve current branch: $current_branch"
ui_clear_live_state
pass "Resolve current branch: $current_branch"

ui_set_live_task_state "running" "Verify working tree is clean"
if ! git diff --quiet; then
    die "Unstaged changes detected. Stage or stash them first."
fi
if ! git diff --cached --quiet; then
    die "Uncommitted staged changes detected. Commit or stash them first."
fi
ui_set_live_task_state "pass" "Verify working tree is clean"
ui_clear_live_state
pass "Verify working tree is clean"

new_branch="staged/$current_branch"

ui_set_live_task_state "running" "Verify branch '$new_branch' does not already exist"
if git show-ref --verify --quiet "refs/heads/$new_branch"; then
    die "Branch '$new_branch' already exists. Delete it or choose a different source branch."
fi
ui_set_live_task_state "pass" "Verify branch '$new_branch' does not already exist"
ui_clear_live_state
pass "Verify branch '$new_branch' does not already exist"

run_step \
    "Fetch latest from origin/main" \
    "Failed to fetch origin/main. Check your network connection." \
    git fetch origin main || exit 1

run_step \
    "Create and switch to '$new_branch' from main" \
    "Failed to create '$new_branch' from main." \
    git checkout -b "$new_branch" main || exit 1

run_step \
    "Squash-merge '$current_branch' into '$new_branch'" \
    "Squash merge failed. Resolve conflicts, then continue manually." \
    git merge --squash "$current_branch" || exit 1

if git diff --cached --quiet; then
    die "No staged changes after squash merge. Nothing to prepare."
fi

pass "Created '$new_branch' from main with squashed changes from '$current_branch' staged and uncommitted."
