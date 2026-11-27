import { spawn } from "node:child_process";
import { escapeRegExp } from "../utils/regexp.ts";
import { hasControlCharacter } from "../utils/chars.ts";
import { toDisplayPath } from "./path-prefix.ts";

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegExp(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

// Use fd to walk directory tree (fast, respects .gitignore)
export async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
	maxDepth?: number,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (maxDepth !== undefined) {
		args.push("--max-depth", String(maxDepth));
	}

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const lines = stdout.trim().split("\n").filter(Boolean);
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			for (const line of lines) {
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					continue;
				}
				// Paths with control characters would write their escapes to the terminal as suggestion labels.
				if (hasControlCharacter(displayLine)) continue;

				results.push({
					path: displayLine,
					isDirectory: hasTrailingSeparator,
				});
			}

			finish(results);
		});
	});
}

export interface FdListEntry {
	/** Path relative to the base directory, `/`-separated, without a trailing slash. */
	path: string;
	isDirectory: boolean;
}

/**
 * Stream every file and directory below `baseDir` (no result limit). `onEntries` receives batches as fd
 * prints them; the walk stops once `cap` entries were delivered. Resolves with `ok: false` when fd cannot
 * run or exits with an error, so the caller can fall back to another source.
 */
export function streamFdEntries(
	baseDir: string,
	fdPath: string,
	cap: number,
	signal: AbortSignal,
	onEntries: (entries: FdListEntry[]) => void,
): Promise<{ ok: boolean; truncated: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(
			fdPath,
			[
				"--base-directory",
				baseDir,
				"--type",
				"f",
				"--type",
				"d",
				"--follow",
				"--hidden",
				"--exclude",
				".git",
				"--exclude",
				".git/*",
				"--exclude",
				".git/**",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let pending = "";
		let delivered = 0;
		let truncated = false;
		let settled = false;

		const settle = (ok: boolean) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", stop);
			resolve({ ok, truncated });
		};
		const stop = () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		};
		const deliver = (lines: string[]) => {
			const batch: FdListEntry[] = [];
			for (const line of lines) {
				if (delivered + batch.length >= cap) {
					truncated = true;
					break;
				}
				if (!line) continue;
				const display = toDisplayPath(line);
				const isDirectory = display.endsWith("/");
				const path = isDirectory ? display.slice(0, -1) : display;
				if (!path || path === ".git" || path.startsWith(".git/") || path.includes("/.git/")) continue;
				// Paths with control characters would write their escapes to the terminal as suggestion labels.
				if (hasControlCharacter(path)) continue;
				batch.push({ path, isDirectory });
			}
			delivered += batch.length;
			if (batch.length > 0) onEntries(batch);
			if (truncated) stop();
		};

		signal.addEventListener("abort", stop, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			if (truncated) return;
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			deliver(lines);
		});
		child.on("error", () => settle(false));
		child.on("close", (code) => {
			if (!truncated && pending) deliver([pending]);
			settle(truncated || (!signal.aborted && code === 0));
		});
	});
}
