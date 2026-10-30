import { execFile, spawnSync } from "node:child_process";

export type MultiplexerId = "tmux" | "screen" | "zellij";

const CLIENT_LOOKUP_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 500;

/** Session markers first (TMUX, STY, ZELLIJ), then the TERM prefix (tmux*, screen*). */
export function detectMultiplexer(env: NodeJS.ProcessEnv = process.env): MultiplexerId | null {
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ !== undefined) return "zellij";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** True only with a live tmux session marker (`TMUX`); `TERM` alone is not a session. */
export function hasTmuxSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.TMUX);
}

/** DCS passthrough envelope: `ESC P tmux; <payload with ESC doubled> ESC \`. */
export function wrapTmuxPassthrough(payload: string): string {
	return `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

const caches = {
	passthrough: new Map<string, boolean>(),
	names: new Map<string, readonly string[]>(),
	features: new Map<string, readonly string[]>(),
};

/** Clears every cached tmux answer (tests). */
export function resetMultiplexerCache(): void {
	for (const cache of Object.values(caches)) cache.clear();
}

function cacheKey(env: NodeJS.ProcessEnv): string {
	return `${env.TMUX ?? ""}\0${env.TMUX_PANE ?? ""}`;
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return env === process.env ? process.env : { ...process.env, ...pick(env, ["TMUX", "TMUX_PANE"]) };
}

/** Runs tmux and returns its stdout, or undefined on a missing binary, timeout or non-zero exit. Never throws. */
function runTmux(args: string[], timeout: number, env: NodeJS.ProcessEnv): string | undefined {
	try {
		const result = spawnSync("tmux", args, {
			encoding: "utf8",
			timeout,
			stdio: ["ignore", "pipe", "ignore"],
			env: childEnv(env),
		});
		if (result.error || result.status !== 0) return undefined;
		return result.stdout;
	} catch {
		return undefined;
	}
}

function pick(env: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
	const picked: NodeJS.ProcessEnv = {};
	for (const key of keys) if (env[key] !== undefined) picked[key] = env[key];
	return picked;
}

function memo<T>(cache: Map<string, T>, env: NodeJS.ProcessEnv, compute: () => T, keep = (_value: T) => true): T {
	const key = cacheKey(env);
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const value = compute();
	if (keep(value)) cache.set(key, value);
	return value;
}

/**
 * Whether the pane lets escape sequences through tmux's DCS passthrough. tmux before 3.3 has no such option and prints
 * nothing, and passes them through; any other failure counts as not allowed.
 */
export function tmuxPaneAllowsPassthrough(env: NodeJS.ProcessEnv = process.env): boolean {
	return memo(caches.passthrough, env, () => {
		const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
		const out = runTmux(["show-options", "-Apqv", ...target, "allow-passthrough"], QUERY_TIMEOUT_MS, env);
		if (out === undefined) return false;
		const value = out.trim().toLowerCase();
		return value === "" || value === "on" || value === "all";
	});
}

/** `Name 1.2` or `name(1.2)` to `name`. */
function terminalName(termtype: string): string {
	return termtype.trim().split(/[\s(]/)[0]?.toLowerCase() ?? "";
}

/**
 * Emulator names of the attached client, best first: the XTVERSION name, then the `TERM` name. `[]` on error or with no
 * client attached; that answer is not cached, so a terminal that attaches later (a session started detached) is found.
 */
export function tmuxClientTerminalNames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	return memo(
		caches.names,
		env,
		() => {
			const out = runTmux(
				["display-message", "-p", "#{client_termtype}\t#{client_termname}"],
				CLIENT_LOOKUP_TIMEOUT_MS,
				env,
			);
			if (out === undefined) return [];
			const [termtype = "", termname = ""] = out.replace(/\r?\n$/, "").split("\t");
			return [...new Set([terminalName(termtype), termname.trim().toLowerCase()].filter(Boolean))];
		},
		(names) => names.length > 0,
	);
}

/**
 * The clients attached to this pane's session, one `pid created` entry each, without blocking. Uncached: a client that
 * attaches later is new here. Resolves undefined when tmux cannot answer.
 */
export function tmuxPaneClients(env: NodeJS.ProcessEnv = process.env): Promise<readonly string[] | undefined> {
	const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
	return new Promise((resolve) => {
		try {
			const args = ["list-clients", ...target, "-F", "#{client_pid} #{client_created}"];
			execFile("tmux", args, { encoding: "utf8", timeout: QUERY_TIMEOUT_MS, env: childEnv(env) }, (error, stdout) =>
				resolve(error ? undefined : stdout.split("\n").filter((line) => line.trim() !== "")),
			);
		} catch {
			resolve(undefined);
		}
	});
}

/** The attached client's `client_termfeatures`, split on commas. `[]` on error. */
export function tmuxClientTermFeatures(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	return memo(caches.features, env, () => {
		const out = runTmux(["display-message", "-p", "#{client_termfeatures}"], QUERY_TIMEOUT_MS, env);
		if (out === undefined) return [];
		return out
			.split(",")
			.map((feature) => feature.trim())
			.filter(Boolean);
	});
}
