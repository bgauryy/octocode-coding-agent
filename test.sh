#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_path="$(type -P node)"
readonly repo_root node_path
cd -- "$repo_root"

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
test_root="$(mktemp -d "$temp_parent/octocode-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.octocode-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/octocode-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.octocode-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"OCTOCODE_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Trust extra certificates of proxies that inspect HTTPS (corporate proxies, sandboxes).
# Network tests fail with self-signed certificate errors without it.
value="${NODE_EXTRA_CA_CERTS-}"
[[ -z "$value" ]] || test_env+=("NODE_EXTRA_CA_CERTS=$value")

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
# The runner uses the checked-in Yarn release directly, even with a fresh HOME.
# Keep the shell alive until cancellation has stopped the runner and its suites.
runner_pid=""
cancel() {
	trap '' INT TERM HUP
	if [[ -n "$runner_pid" ]]; then
		kill -s "$1" "$runner_pid" 2>/dev/null || true
		wait "$runner_pid" || true
	fi
	exit "$2"
}
trap 'cancel INT 130' INT
trap 'cancel TERM 143' TERM
trap 'cancel HUP 129' HUP
env -i "${test_env[@]}" "$node_path" "$repo_root/scripts/test/test-workspaces.mjs" "$@" &
runner_pid=$!
status=0
wait "$runner_pid" || status=$?
exit "$status"
