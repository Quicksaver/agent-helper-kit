#!/usr/bin/env bash
# release.sh — Bump the version, publish a tagged GitHub release, and publish the extension package.
#
# Usage: ./scripts/release.sh <major|minor|patch>
#
# Flow:
#   1. Validate bump type and ensure the repo is clean on main
#   2. Verify GitHub CLI authentication
#   3. Update package.json version and roll Unreleased changelog entries
#   4. Build the VSIX package
#   5. Commit the release changes, tag the commit, and push branch + tag
#   6. Create a GitHub release from the matching changelog section and attach the VSIX
#   7. Publish the extension package

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/terminal-ui.sh
source "$SCRIPT_DIR/lib/terminal-ui.sh"

ui_set_prefix "[release]"
ui_set_render_mode "task_only"
ui_init

release_notes_file=""

cleanup() {
    if [[ -n "$release_notes_file" && -f "$release_notes_file" ]]; then
        rm -f "$release_notes_file"
    fi
}

trap 'cleanup; ui_finalize' EXIT

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

read_package_field() {
    local field_name="$1"

    node - "$package_json_path" "$field_name" <<'NODE'
const fs = require('fs');

const packageJsonPath = process.argv[2];
const fieldName = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const fieldValue = packageJson[fieldName];

if (typeof fieldValue !== 'string') {
  throw new Error(`Missing string ${fieldName} in package.json`);
}

process.stdout.write(fieldValue);
NODE
}

update_package_json_version() {
    local next_version="$1"

    node - "$package_json_path" "$next_version" <<'NODE'
const fs = require('fs');
const packageJsonPath = process.argv[2];
const nextVersion = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
}

roll_unreleased_changelog_entries() {
    local next_version="$1"
    local release_date="$2"

    node - "$changelog_path" "$next_version" "$release_date" <<'NODE'
const fs = require('fs');

const changelogPath = process.argv[2];
const nextVersion = process.argv[3];
const releaseDate = process.argv[4];
const unreleasedHeadingPattern = /^## \[Unreleased\][ \t]*$/m;
const releaseHeadingPattern = /^## \[(?!Unreleased\])[^\]]+\][^\n]*$/m;

function trimSurroundingNewlineRuns(value) {
  return value.replace(/^\n+|\n+$/g, '');
}

const changelog = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n?/g, '\n');
const unreleasedMatch = unreleasedHeadingPattern.exec(changelog);

if (unreleasedMatch === null || unreleasedMatch.index === undefined) {
  throw new Error('Missing Unreleased heading');
}

const unreleasedStart = unreleasedMatch.index;
const unreleasedLineEnd = changelog.indexOf('\n', unreleasedStart);
const afterUnreleasedStart = unreleasedLineEnd === -1 ? changelog.length : unreleasedLineEnd + 1;
const nextHeadingMatch = releaseHeadingPattern.exec(changelog.slice(afterUnreleasedStart));
const unreleasedEnd = nextHeadingMatch === null
  ? changelog.length
  : afterUnreleasedStart + nextHeadingMatch.index;

const beforeUnreleased = changelog.slice(0, unreleasedStart);
const unreleasedBody = changelog.slice(afterUnreleasedStart, unreleasedEnd);
const afterUnreleased = trimSurroundingNewlineRuns(changelog.slice(unreleasedEnd));

const normalizedBody = unreleasedBody.trim();
const releaseBody = normalizedBody.length === 0 ? 'Version bump only.' : normalizedBody;
const releaseHeading = `## [${nextVersion}] - ${releaseDate}`;

let updated = `${beforeUnreleased}## [Unreleased]\n\n${releaseHeading}\n\n${releaseBody}`;
if (afterUnreleased.length > 0) {
  updated += `\n\n${afterUnreleased}`;
}
updated += '\n';

fs.writeFileSync(changelogPath, updated);
NODE
}

extract_release_notes() {
    local version="$1"
    local output_path="$2"

    node - "$changelog_path" "$version" "$output_path" <<'NODE'
const fs = require('fs');

const changelogPath = process.argv[2];
const version = process.argv[3];
const outputPath = process.argv[4];
const changelog = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n?/g, '\n');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const releaseHeadingPattern = new RegExp(`^## \\[${escapedVersion}\\][^\\n]*$`, 'm');
const nextReleaseHeadingPattern = /^## \[(?!Unreleased\])[^\]]+\][^\n]*$/m;
const releaseHeadingMatch = releaseHeadingPattern.exec(changelog);

if (releaseHeadingMatch === null || releaseHeadingMatch.index === undefined) {
  throw new Error(`Missing changelog section for ${version}`);
}

const releaseStart = releaseHeadingMatch.index;
const releaseLineEnd = changelog.indexOf('\n', releaseStart);
const afterReleaseStart = releaseLineEnd === -1 ? changelog.length : releaseLineEnd + 1;
const nextHeadingMatch = nextReleaseHeadingPattern.exec(changelog.slice(afterReleaseStart));
const releaseEnd = nextHeadingMatch === null
  ? changelog.length
  : afterReleaseStart + nextHeadingMatch.index;

const releaseBody = changelog.slice(afterReleaseStart, releaseEnd).replace(/^\n+|\n+$/g, '');

if (releaseBody.length === 0) {
  throw new Error(`Release notes for ${version} are empty`);
}

fs.writeFileSync(outputPath, `${releaseBody}\n`);
NODE
}

validate_bump_type() {
    local candidate="$1"

    case "$candidate" in
        major|minor|patch)
            ;;
        *)
            die "Usage: ./scripts/release.sh <major|minor|patch>"
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

ensure_main_branch() {
    ui_set_live_task_state "running" "Resolve current branch"
    current_branch="$(git -C "$project_root" symbolic-ref --short HEAD 2>/dev/null)" \
        || die "Not on any branch (detached HEAD?)."
    if [[ "$current_branch" != "main" ]]; then
        die "Release must be run from 'main'. Current branch: $current_branch."
    fi
    ui_set_live_task_state "pass" "Resolve current branch: $current_branch"
    ui_clear_live_state
    pass "Resolve current branch: $current_branch"
}

ensure_clean_working_tree() {
    ui_set_live_task_state "running" "Verify working tree is clean"
    if ! git -C "$project_root" diff --quiet; then
        die "Unstaged changes detected. Stage or stash them first."
    fi
    if ! git -C "$project_root" diff --cached --quiet; then
        die "Uncommitted staged changes detected. Commit or stash them first."
    fi
    if [[ -n "$(git -C "$project_root" status --porcelain --untracked-files=all 2>/dev/null | grep -E '^\?\?' || true)" ]]; then
        die "Untracked files detected. Commit, clean, or stash them first."
    fi
    ui_set_live_task_state "pass" "Verify working tree is clean"
    ui_clear_live_state
    pass "Verify working tree is clean"
}

ensure_github_cli_authenticated() {
    if ! command -v gh >/dev/null 2>&1; then
        die "GitHub CLI (gh) is required but was not found in PATH."
    fi

    run_step \
        "Verify GitHub CLI authentication" \
        "Run 'gh auth login' and retry." \
        gh auth status --hostname github.com || exit 1
}

ensure_tag_does_not_exist() {
    local release_tag="$1"

    if git -C "$project_root" rev-parse --verify --quiet "refs/tags/$release_tag" >/dev/null; then
        die "Tag '$release_tag' already exists locally."
    fi
}

resolve_built_vsix_path() {
    local package_name="$1"
    local version="$2"

    built_vsix_path="$project_root/$package_name-$version.vsix"
    if [[ ! -f "$built_vsix_path" ]]; then
        die "Expected built VSIX at $built_vsix_path, but it was not found."
    fi
}

if [[ $# -ne 1 ]]; then
    die "Usage: ./scripts/release.sh <major|minor|patch>"
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

ui_set_live_section_running "Create release"

ensure_main_branch
ensure_clean_working_tree
ensure_github_cli_authenticated

ui_set_live_task_state "running" "Resolve current version"
current_version="$(read_package_field version)" \
    || die "Failed to read version from package.json."
package_name="$(read_package_field name)" \
    || die "Failed to read package name from package.json."
next_version="$(compute_next_version "$current_version" "$bump_type")"
release_tag="v$next_version"
release_date="$(date '+%Y-%m-%d')"
ensure_tag_does_not_exist "$release_tag"
ui_set_live_task_state "pass" "Resolve version bump: $current_version -> $next_version"
ui_clear_live_state
pass "Resolve version bump: $current_version -> $next_version"

run_step \
    "Update package.json version to $next_version" \
    "Failed to update package.json version." \
    update_package_json_version "$next_version" || exit 1

run_step \
    "Roll Unreleased changelog entries into $next_version" \
    "Failed to update CHANGELOG.md. Ensure it contains an '## [Unreleased]' section." \
    roll_unreleased_changelog_entries "$next_version" "$release_date" || exit 1

run_step \
    "Build VSIX package for $next_version" \
    "Failed to build the VSIX package via yarn package:build." \
    yarn package:build || exit 1

resolve_built_vsix_path "$package_name" "$next_version"

run_step \
    "Commit release changes for $release_tag" \
    "Failed to create the release commit." \
    git -C "$project_root" add package.json CHANGELOG.md || exit 1

run_step \
    "Create release commit for $release_tag" \
    "Failed to create the release commit." \
    git -C "$project_root" commit -m "Bump version to $release_tag" || exit 1

run_step \
    "Create git tag $release_tag" \
    "Failed to create tag $release_tag." \
    git -C "$project_root" tag "$release_tag" || exit 1

run_step \
    "Push main and $release_tag to origin" \
    "Failed to push branch or tag to origin." \
    git -C "$project_root" push origin "$current_branch" "$release_tag" || exit 1

release_notes_file="$(mktemp "${TMPDIR:-/tmp}/agent-helper-kit-release-notes.XXXXXX")"

run_step \
    "Extract release notes for $next_version" \
    "Failed to extract release notes for $next_version from CHANGELOG.md." \
    extract_release_notes "$next_version" "$release_notes_file" || exit 1

run_step \
    "Create GitHub release $release_tag" \
    "Failed to create the GitHub release for $release_tag." \
    gh release create "$release_tag" "$built_vsix_path" --title "$next_version" --notes-file "$release_notes_file" || exit 1

run_step \
    "Publish extension package for $next_version" \
    "Failed to publish the extension package via yarn package:publish." \
    yarn package:publish || exit 1

pass "Released $release_tag and published package version $next_version."