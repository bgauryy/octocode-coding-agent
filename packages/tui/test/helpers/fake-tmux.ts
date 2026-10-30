import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake `tmux` answers; an omitted reply prints nothing and exits 0, as tmux does for an unknown option. */
export interface FakeTmuxReplies {
	/** `#{client_termtype}`, for example `kitty(0.35.2)`. */
	clientTermtype?: string;
	/** `#{client_termname}`, for example `xterm-kitty`. */
	clientTermname?: string;
	/** `#{client_termfeatures}`, for example `256,hyperlinks,RGB`. */
	termfeatures?: string;
	/** The pane's `allow-passthrough` as `show-options -Apqv` prints it: `on`, `off`, `all`. */
	allowPassthrough?: string;
	/** The server's `extended-keys` as `show -gv extended-keys` prints it: `on`, `off`, `always`. */
	extendedKeys?: string;
	/** Queries that exit 1 instead of answering. */
	fail?: ("client" | "features" | "passthrough" | "extendedKeys")[];
}

export interface FakeTmux {
	/** Arguments of every tmux call so far, one string per call. */
	calls(): string[];
	/** Restores PATH and removes this install's reply directory. */
	restore(): void;
}

/**
 * One executable shared by every install, answering from the directory named by `FAKE_TMUX_DIR`. It uses shell builtins
 * only (no `dirname` or `cat` forks). macOS spends ~200 ms assessing the first run of a newly written executable, and
 * far more under load, so a fresh script per install would exceed the production query timeouts (500 ms); the shared
 * script is run once, with no timeout, before the first install returns.
 */
const SCRIPT = `#!/bin/sh
dir="$FAKE_TMUX_DIR"
echo "$*" >> "$dir/calls.log"
case "$1" in
display-message)
	case "$*" in
	*client_termfeatures*) name=features ;;
	*client_termtype*) name=client ;;
	*) exit 1 ;;
	esac ;;
show-options) name=passthrough ;;
show) name=extendedKeys ;;
*) exit 1 ;;
esac
[ -f "$dir/$name.fail" ] && exit 1
if [ -f "$dir/$name" ]; then
	IFS= read -r line < "$dir/$name"
	printf '%s\\n' "$line"
fi
exit 0
`;

let binDir: string | undefined;

function sharedBinDir(): string {
	if (binDir) return binDir;
	const dir = mkdtempSync(join(tmpdir(), "fake-tmux-bin-"));
	const executable = join(dir, "tmux");
	writeFileSync(executable, SCRIPT);
	chmodSync(executable, 0o755);
	const stateDir = mkdtempSync(join(tmpdir(), "fake-tmux-warm-"));
	try {
		spawnSync(executable, ["warm-up"], { env: { ...process.env, FAKE_TMUX_DIR: stateDir }, stdio: "ignore" });
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	binDir = dir;
	return dir;
}

/** Puts a fake `tmux` first on PATH answering `display-message`, `show-options` and `show` with the given replies. */
export function installFakeTmux(replies: FakeTmuxReplies = {}): FakeTmux {
	const bin = sharedBinDir();
	const dir = mkdtempSync(join(tmpdir(), "fake-tmux-"));
	writeFileSync(join(dir, "calls.log"), "");
	if (replies.clientTermtype !== undefined || replies.clientTermname !== undefined) {
		writeFileSync(join(dir, "client"), `${replies.clientTermtype ?? ""}\t${replies.clientTermname ?? ""}\n`);
	}
	if (replies.termfeatures !== undefined) writeFileSync(join(dir, "features"), `${replies.termfeatures}\n`);
	if (replies.allowPassthrough !== undefined) writeFileSync(join(dir, "passthrough"), `${replies.allowPassthrough}\n`);
	if (replies.extendedKeys !== undefined) writeFileSync(join(dir, "extendedKeys"), `${replies.extendedKeys}\n`);
	for (const name of replies.fail ?? []) writeFileSync(join(dir, `${name}.fail`), "");
	const previousPath = process.env.PATH;
	const previousDir = process.env.FAKE_TMUX_DIR;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.FAKE_TMUX_DIR = dir;
	return {
		calls: () => readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
		restore: () => {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousDir === undefined) delete process.env.FAKE_TMUX_DIR;
			else process.env.FAKE_TMUX_DIR = previousDir;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
