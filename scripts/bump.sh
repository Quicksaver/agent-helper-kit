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

ui_set_live_task_state "running" "Resolve current version"
current_version="$(node -p "require('$package_json_path').version" 2>/dev/null)" \
    || die "Failed to read version from package.json."
next_version="$(compute_next_version "$current_version" "$bump_type")"
release_date="$(date +%F)"
ui_set_live_task_state "pass" "Resolve version bump: $current_version -> $next_version"
ui_clear_live_state
pass "Resolve version bump: $current_version -> $next_version"

run_step \
    "Update package.json version to $next_version" \
    "Failed to update package.json version." \
    node -e '
const fs = require("fs");
const packageJsonPath = process.argv[1];
const nextVersion = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
' "$package_json_path" "$next_version" || exit 1

run_step \
    "Roll Unreleased changelog entries into $next_version" \
    "Failed to update CHANGELOG.md. Ensure it contains an '## [Unreleased]' section." \
    node -e '
const fs = require("fs");

const changelogPath = process.argv[1];
const nextVersion = process.argv[2];
const releaseDate = process.argv[3];
const unreleasedHeading = "## [Unreleased]";

const changelog = fs.readFileSync(changelogPath, "utf8");
const unreleasedStart = changelog.indexOf(`${unreleasedHeading}\n`);

if (unreleasedStart === -1) {
  throw new Error("Missing Unreleased heading");
}

const afterUnreleasedStart = unreleasedStart + unreleasedHeading.length + 1;
const nextHeadingMatch = /^## \[(?!Unreleased\]).+$/m.exec(changelog.slice(afterUnreleasedStart));
const unreleasedEnd = nextHeadingMatch === null
  ? changelog.length
  : afterUnreleasedStart + nextHeadingMatch.index;

const beforeUnreleased = changelog.slice(0, unreleasedStart);
const unreleasedBody = changelog.slice(afterUnreleasedStart, unreleasedEnd);
const afterUnreleased = changelog.slice(unreleasedEnd).replace(/^\n+/, "");

const normalizedBody = unreleasedBody.replace(/^\n+|\n+$/g, "");
const releaseBody = normalizedBody.length === 0 ? "Version bump only." : normalizedBody;
const releaseHeading = `## [${nextVersion}] ${releaseDate}`;

let updated = `${beforeUnreleased}${unreleasedHeading}\n\n${releaseHeading}\n\n${releaseBody}`;
if (afterUnreleased.length > 0) {
  updated += `\n\n${afterUnreleased}`;
}
updated += "\n";

fs.writeFileSync(changelogPath, updated);
' "$changelog_path" "$next_version" "$release_date" || exit 1

pass "Bumped version to $next_version and rolled changelog entries into $release_date."
