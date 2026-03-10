#!/usr/bin/env bash
# bump.sh — Bump package.json version and roll Unreleased changelog entries.
#
# Usage: ./scripts/bump.sh <major|minor|patch>
#
# Flow:
#   1. Validate bump type and current version
#   2. Update package.json version
#   3. Move the Unreleased changelog block into a dated release heading
#   4. Leave a purposefully empty Unreleased block at the top

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/terminal-ui.sh
source "$SCRIPT_DIR/lib/terminal-ui.sh"

ui_set_prefix "[bump]"
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

ensure_clean_release_files() {
    if ! command -v git >/dev/null 2>&1; then
        return 0
    fi

    if ! git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 0
    fi

    if [[ -n "$(git -C "$project_root" status --porcelain -- package.json CHANGELOG.md)" ]]; then
        die "package.json or CHANGELOG.md has uncommitted changes. Commit or stash them before bumping."
    fi
}

read_package_version() {
    node - "$package_json_path" <<'NODE'
const fs = require("fs");

const packageJsonPath = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

if (typeof packageJson.version !== "string") {
  throw new Error("Missing string version in package.json");
}

process.stdout.write(packageJson.version);
NODE
}

update_package_json_version() {
    local next_version="$1"

    node - "$package_json_path" "$next_version" <<'NODE'
const fs = require("fs");
const packageJsonPath = process.argv[2];
const nextVersion = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
}

roll_unreleased_changelog_entries() {
    local next_version="$1"
    local release_date="$2"

    node - "$changelog_path" "$next_version" "$release_date" <<'NODE'
const fs = require("fs");

const changelogPath = process.argv[2];
const nextVersion = process.argv[3];
const releaseDate = process.argv[4];
const unreleasedHeadingPattern = /^## \[Unreleased\][ \t]*$/m;
const releaseHeadingPattern = /^## \[(?!Unreleased\])[^\]]+\][^\n]*$/m;

function trimSurroundingNewlineRuns(value) {
    return value.replace(/^\n+|\n+$/g, "");
}

const changelog = fs.readFileSync(changelogPath, "utf8").replace(/\r\n?/g, "\n");
const unreleasedMatch = unreleasedHeadingPattern.exec(changelog);

if (unreleasedMatch === null || unreleasedMatch.index === undefined) {
    throw new Error("Missing Unreleased heading");
}

const unreleasedStart = unreleasedMatch.index;
const unreleasedLineEnd = changelog.indexOf("\n", unreleasedStart);
const afterUnreleasedStart = unreleasedLineEnd === -1 ? changelog.length : unreleasedLineEnd + 1;
const nextHeadingMatch = releaseHeadingPattern.exec(changelog.slice(afterUnreleasedStart));
const unreleasedEnd = nextHeadingMatch === null
    ? changelog.length
    : afterUnreleasedStart + nextHeadingMatch.index;

const beforeUnreleased = changelog.slice(0, unreleasedStart);
const unreleasedBody = changelog.slice(afterUnreleasedStart, unreleasedEnd);
const afterUnreleased = trimSurroundingNewlineRuns(changelog.slice(unreleasedEnd));

const normalizedBody = unreleasedBody.trim();
const releaseBody = normalizedBody.length === 0 ? "Version bump only." : normalizedBody;
const releaseHeading = `## [${nextVersion}] - ${releaseDate}`;

let updated = `${beforeUnreleased}## [Unreleased]\n\n${releaseHeading}\n\n${releaseBody}`;
if (afterUnreleased.length > 0) {
    updated += `\n\n${afterUnreleased}`;
}
updated += "\n";

fs.writeFileSync(changelogPath, updated);
NODE
}

validate_bump_type() {
    local candidate="$1"

    case "$candidate" in
        major|minor|patch)
            ;;
        *)
            die "Usage: ./scripts/bump.sh <major|minor|patch>"
            ;;
    esac
}

compute_next_version() {
    local current_version="$1"
    local bump_type="$2"
    local major minor patch

    if [[ ! "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        die "package.json version '$current_version' is not in x.y.z format."
    fi

    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"

    case "$bump_type" in
        major)
            echo "$((major + 1)).0.0"
            ;;
        minor)
            echo "$major.$((minor + 1)).0"
            ;;
        patch)
            echo "$major.$minor.$((patch + 1))"
            ;;
    esac
}

ui_set_live_section_running "Bump project version"

if [[ $# -ne 1 ]]; then
    die "Usage: ./scripts/bump.sh <major|minor|patch>"
fi

bump_type="$1"
validate_bump_type "$bump_type"

project_root="$(cd "$SCRIPT_DIR/.." && pwd)"
package_json_path="$project_root/package.json"
changelog_path="$project_root/CHANGELOG.md"

if [[ ! -f "$package_json_path" ]]; then
    die "Could not find package.json at $package_json_path."
fi

if [[ ! -f "$changelog_path" ]]; then
    die "Could not find CHANGELOG.md at $changelog_path."
fi

ensure_clean_release_files

ui_set_live_task_state "running" "Resolve current version"
current_version="$(read_package_version)" \
    || die "Failed to read version from package.json."
next_version="$(compute_next_version "$current_version" "$bump_type")"
release_date="$(date '+%Y-%m-%d')"
ui_set_live_task_state "pass" "Resolve version bump: $current_version -> $next_version"
ui_clear_live_state
pass "Resolve version bump: $current_version -> $next_version"

run_step \
    "Update package.json version to $next_version" \
    "Failed to update package.json version." \
    update_package_json_version "$next_version"

run_step \
    "Roll Unreleased changelog entries into $next_version" \
    "Failed to update CHANGELOG.md. Ensure it contains an '## [Unreleased]' section." \
    roll_unreleased_changelog_entries "$next_version" "$release_date"

pass "Bumped version to $next_version and rolled changelog entries into $release_date."
