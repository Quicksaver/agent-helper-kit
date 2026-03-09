#!/usr/bin/env bash

env_resolve_repo_root() {
    local root

    root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -z "$root" ]]; then
        return 1
    fi

    echo "$root"
}

env_update_value_in_file() {
    local file_path="$1"
    local variable_name="$2"
    local value="$3"
    local tmp_file

    tmp_file="$(mktemp)"

    if ! awk -v key="$variable_name" -v value="$value" '
        BEGIN { updated = 0 }
        {
            pattern = "^[[:space:]]*#?[[:space:]]*" key "="
            if ($0 ~ pattern && updated == 0) {
                eq = index($0, "=")
                prefix = substr($0, 1, eq)
                print prefix value
                updated = 1
                next
            }
            print
        }
        END {
            if (updated == 0) {
                exit 42
            }
        }
    ' "$file_path" > "$tmp_file"; then
        rm -f "$tmp_file"
        return 1
    fi

    mv "$tmp_file" "$file_path"
}
