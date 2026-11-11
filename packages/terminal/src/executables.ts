import { accessSync, constants, statSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";

const isWindows = process.platform === "win32";

function extensions(env: NodeJS.ProcessEnv): string[] {
	return isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";").filter(Boolean) : [""];
}

function executable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (!isWindows) accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The first `name` on `env.PATH` that is an executable file, or undefined. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (name.includes("/") || (isWindows && name.includes("\\"))) return executable(name) ? name : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions(env)) {
			const candidate = join(dir, name + ext);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * The program names on PATH, scanned once per PATH value and again when the scan is older than `maxAgeMs` (a program
 * installed meanwhile). Scans use asynchronous I/O and share a build across requests.
 */
export class PathCommands {
	private cached: { path: string; at: number; names: string[] } | undefined;
	private pending: { path: string; result: Promise<string[]> } | undefined;
	private readonly maxAgeMs: number;

	constructor(maxAgeMs = 30_000) {
		this.maxAgeMs = maxAgeMs;
	}

	async list(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
		const path = `${env.PATH ?? ""}\0${env.PATHEXT ?? ""}`;
		const now = Date.now();
		if (this.cached?.path === path && now - this.cached.at < this.maxAgeMs) return this.cached.names;
		if (this.pending?.path === path) return this.pending.result;
		const result = this.scan({ PATH: env.PATH, PATHEXT: env.PATHEXT });
		const pending = { path, result };
		this.pending = pending;
		try {
			const names = await result;
			if (this.pending === pending) this.cached = { path, at: Date.now(), names };
			return names;
		} finally {
			if (this.pending === pending) this.pending = undefined;
		}
	}

	private async scan(env: NodeJS.ProcessEnv): Promise<string[]> {
		const names = new Set<string>();
		const exts = extensions(env);
		for (const dir of new Set((env.PATH ?? "").split(delimiter))) {
			if (!dir) continue;
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch {
				continue;
			}
			// Bound concurrent filesystem work even for a directory containing many installed commands.
			for (let at = 0; at < entries.length; at += 32) {
				await Promise.all(
					entries.slice(at, at + 32).map(async (entry) => {
						const lower = entry.toLowerCase();
						const ext = exts.find((each) => each && lower.endsWith(each));
						if (isWindows && !ext) return;
						const name = ext ? entry.slice(0, -ext.length) : entry;
						if (names.has(name)) return;
						const candidate = join(dir, entry);
						try {
							if (!(await stat(candidate)).isFile()) return;
							if (!isWindows) await access(candidate, constants.X_OK);
							names.add(name);
						} catch {
							// Broken links and inaccessible entries are not commands.
						}
					}),
				);
			}
		}
		return [...names].sort();
	}
}

/** The shell named by `env.SHELL` (`/bin/zsh` → `zsh`), or undefined. */
export function loginShellName(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const shell = env.SHELL;
	return shell ? basename(shell).replace(/\.exe$/i, "") : undefined;
}
