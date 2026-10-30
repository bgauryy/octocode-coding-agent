#!/usr/bin/env bash
# Real-CLI tmux check. Starts the source CLI in a private tmux server (never your default server) and checks
# startup and multi-line paste. With --model, sends one short prompt to the configured model, then checks
# /fork pane, /fork pane down, /fork window and Kitty placeholder rows for a fetched PNG.
# --cli=<command> checks another launcher, for example a compiled Bun binary, instead of ./octocode-test.sh.
# Usage: packages/coding-agent/scripts/tmux-cli-check.sh [--model] [--keep] [--cli=<command>]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOCKET="octocode-cli-check-$$"
T="tmux -L $SOCKET"
MODEL=false
KEEP=false
CLI=./octocode-test.sh
for arg in "$@"; do
	case "$arg" in
	--model) MODEL=true ;;
	--keep) KEEP=true ;;
	--cli=*) CLI="${arg#--cli=}" ;;
	*) echo "unknown argument: $arg" >&2; exit 2 ;;
	esac
done
command -v tmux >/dev/null || { echo "SKIP: tmux is not installed"; exit 0; }

failures=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }
screen() { $T capture-pane -t "${1:-cli:0}" -p; }
cleanup() { [[ "$KEEP" == true ]] && echo "kept: tmux -L $SOCKET attach -t cli" || $T kill-server 2>/dev/null || true; }
trap cleanup EXIT

# wait_for <pattern> <seconds> [target]
wait_for() {
	local end=$((SECONDS + $2))
	while ((SECONDS < end)); do screen "${3:-cli:0}" | grep -q -- "$1" && return 0; sleep 1; done
	return 1
}

# submit <text>: the first Enter may only accept an autocomplete suggestion.
submit() {
	$T send-keys -t cli:0.0 -l "$1"
	sleep 0.5
	$T send-keys -t cli:0.0 Enter
	sleep 0.7
	if screen cli:0.0 | grep -q -F -- "│ $1"; then $T send-keys -t cli:0.0 Enter; fi
}

$T -f /dev/null new-session -d -s cli -x 120 -y 40 -c "$REPO"
$T set -g extended-keys on
$T set -g allow-passthrough on
$T send-keys -t cli:0 "OCTOCODE_IMAGE_PROTOCOL=kitty $CLI" Enter
if wait_for "╭── octocode" 60; then pass "startup: editor box drawn inside tmux"; else fail "startup: editor box not drawn"; screen; exit 1; fi
if screen | grep -q "extended-keys"; then fail "startup: extended-keys warning shown although it is on"; else pass "startup: no extended-keys warning"; fi

printf 'first pasted line\nsecond pasted line' | $T load-buffer -b paste -
$T paste-buffer -p -b paste -t cli:0
sleep 1.5
if screen | grep -q "│ first pasted line" && screen | grep -q "│ second pasted line"; then
	pass "paste: bracketed multi-line paste keeps its lines"
else
	fail "paste: lines not in the editor"
fi
if screen | grep -q "27;5;"; then fail "paste: extended-key text leaked into the editor"; fi
$T send-keys -t cli:0 C-c
sleep 0.5

if [[ "$MODEL" == true ]]; then
	submit "Use the web tool to fetch https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png, then reply with only the word: shown"
	if wait_for "Worked for" 120 cli:0.0; then pass "model: reply received"; else fail "model: no reply within 120s"; fi
	cells=$(screen cli:0.0 | grep -c $'\xf4\x8e\xbb\xae' || true)
	if ((cells > 0)); then pass "images: $cells Kitty placeholder rows in the pane"; else fail "images: no placeholder rows"; fi

	submit "/fork pane"
	if wait_for "Opened fork in tmux pane %" 20 cli:0.0; then pass "fork: /fork pane"; else fail "fork: /fork pane"; fi
	submit "/fork pane down"
	if wait_for "Opened fork in tmux pane %" 20 cli:0.0 && (($($T list-panes -t cli:0 | wc -l) == 3)); then pass "fork: /fork pane down"; else fail "fork: /fork pane down"; fi
	submit "/fork window"
	if wait_for "Opened fork in tmux window @" 20 cli:0.0 && (($($T list-windows -t cli | wc -l) == 2)); then pass "fork: /fork window"; else fail "fork: /fork window"; fi
	sleep 8
	if screen cli:1 | grep -q "╭── octocode"; then pass "fork: forked window runs the CLI"; else fail "fork: forked window shows no CLI"; fi
fi

echo "failures: $failures"
((failures == 0))
