import { spawn } from "node:child_process";
import { hasControlCharacter } from "../utils/chars.ts";
import type { FdListEntry } from "./fd.ts";

/** Stream NUL-delimited Git paths; cap files and derived directories together before buffering the whole tree. */
export function buildGitIndex(
	cwd: string,
	cap: number,
	progress: (count: number) => void,
): Promise<{
	entries: FdListEntry[];
	truncated: boolean;
	source: "git";
} | null> {
	return new Promise((resolve) => {
		const child = spawn("git", ["-C", cwd, "ls-files", "-z", "-c", "-o", "--exclude-standard"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const entries = new Map<string, FdListEntry>();
		let pending = "";
		let truncated = false;
		let failed = false;
		const stop = () => {
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			failed = true;
			stop();
		}, 5000);
		const add = (path: string, isDirectory: boolean): boolean => {
			if (entries.has(path)) return true;
			if (entries.size >= cap) {
				truncated = true;
				stop();
				return false;
			}
			entries.set(path, { path, isDirectory });
			return true;
		};
		const accept = (file: string) => {
			if (!file || hasControlCharacter(file) || !add(file, false)) return;
			for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) {
				if (!add(file.slice(0, slash), true)) return;
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (truncated || failed) return;
			pending += chunk;
			let start = 0;
			for (let end = pending.indexOf("\0"); end !== -1; end = pending.indexOf("\0", start)) {
				accept(pending.slice(start, end));
				start = end + 1;
				if (truncated) break;
			}
			pending = truncated ? "" : pending.slice(start);
			// A malformed producer must not retain an unbounded unterminated path.
			if (pending.length > 1024 * 1024) {
				failed = true;
				stop();
			}
			progress(entries.size);
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(
				!failed && (truncated || code === 0) ? { entries: [...entries.values()], truncated, source: "git" } : null,
			);
		});
	});
}
