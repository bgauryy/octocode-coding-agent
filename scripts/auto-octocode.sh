#!/usr/bin/env bash
set -euo pipefail

# Developer wrapper that runs octocode from this checkout's latest `yarn run build`.
# Development invocations use OCTOCODE_EXPERIMENTAL=1 by default. Pass --stable to use
# the next octocode executable on PATH; `octocode update` also uses stable so self-update
# works.
#
# From the repository root, install with:
#   mkdir -p "$HOME/.local/bin"
#   ln -s "$PWD/scripts/auto-octocode.sh" "$HOME/.local/bin/octocode"
#
# ~/.local/bin must appear before the stable octocode installation on PATH.

# Resolve this script through symlinks so repo_dir points at the development
# checkout rather than the directory containing the `octocode` symlink.
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	link_target="$(readlink "$script_path")"
	if [[ "$link_target" == /* ]]; then
		script_path="$link_target"
	else
		script_path="$script_dir/$link_target"
	fi
done
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

find_stable_octocode() {
	local path_entry candidate candidate_dir
	local -a path_entries
	IFS=: read -r -a path_entries <<< "${PATH:-}"
	for path_entry in "${path_entries[@]}"; do
		[[ -n "$path_entry" ]] || path_entry=.
		candidate="$path_entry/octocode"
		[[ -x "$candidate" && ! -d "$candidate" ]] || continue
		[[ "$candidate" -ef "$script_path" ]] && continue
		candidate_dir="$(cd -P "$(dirname "$candidate")" && pwd)" || continue
		printf '%s/%s\n' "$candidate_dir" "$(basename "$candidate")"
		return 0
	done
	return 1
}

use_stable=false
args=()
for arg in "$@"; do
	if [[ "$arg" == "--stable" ]]; then
		use_stable=true
	else
		args+=("$arg")
	fi
done

if [[ "${args[0]:-}" == "update" ]]; then
	use_stable=true
fi

if [[ "$use_stable" == true ]]; then
	if ! stable_octocode="$(find_stable_octocode)"; then
		echo "error: could not find a stable octocode executable after the auto-octocode wrapper on PATH" >&2
		exit 1
	fi
	exec "$stable_octocode" ${args[@]+"${args[@]}"}
fi

dev_octocode="$repo_dir/packages/coding-agent/dist/bundle/cli.js"
if [[ ! -x "$dev_octocode" ]]; then
	echo "error: development octocode build not found; run \`yarn run build\` in $repo_dir" >&2
	exit 1
fi

export OCTOCODE_EXPERIMENTAL="${OCTOCODE_EXPERIMENTAL:-1}"
exec "$dev_octocode" ${args[@]+"${args[@]}"}
