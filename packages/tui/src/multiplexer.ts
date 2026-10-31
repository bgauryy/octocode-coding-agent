import { execFile, spawnSync } from "node:child_process";

export type MultiplexerId = "tmux" | "screen" | "zellij";

const SLOW_QUERY_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 500;
const ASYNC_TIMEOUT_MS = 5000;

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

export type TmuxExecOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
};

/**
 * Runs tmux and resolves its stdout without blocking. Rejects with `tmux failed: <stderr>` (the abort reason when
 * `signal` fired). This is the one asynchronous spawn; launches and queries share it.
 */
export function tmuxExec(args: readonly string[], options: TmuxExecOptions = {}): Promise<string> {
	const { cwd, env, signal, timeoutMs = ASYNC_TIMEOUT_MS } = options;
	return new Promise((resolve, reject) => {
		execFile(
			"tmux",
			[...args],
			{ ...(cwd === undefined ? {} : { cwd }), ...(env ? { env } : {}), signal, timeout: timeoutMs, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (!error) return resolve(stdout);
				if (signal?.aborted) return reject(signal.reason ?? error);
				reject(new Error(`tmux failed: ${stderr.trim() || error.message}`));
			},
		);
	});
}

/** `tmuxExec` for queries: sanitised env, short timeout, undefined instead of a rejection. */
function tmuxQueryAsync(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = QUERY_TIMEOUT_MS,
): Promise<string | undefined> {
	return tmuxExec(args, { env: childEnv(env), timeoutMs }).catch(() => undefined);
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
				SLOW_QUERY_TIMEOUT_MS,
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
	return tmuxQueryAsync(["list-clients", ...target, "-F", "#{client_pid} #{client_created}"], env).then((out) =>
		out?.split("\n").filter((line) => line.trim() !== ""),
	);
}

/** The value of a global tmux option (`show -gv`), trimmed; undefined when tmux cannot answer. Never throws. */
export function tmuxGlobalOption(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return tmuxQueryAsync(["show", "-gv", name], env, SLOW_QUERY_TIMEOUT_MS).then((out) => out?.trim());
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
