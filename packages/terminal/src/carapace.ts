import { execFile } from "node:child_process";
import { DEFAULT_TIMINGS } from "./driver-process.ts";
import type { DriverMatch } from "./types.ts";

/** The part of carapace's `export` JSON Octocode reads. */
interface CarapaceExport {
	nospace?: string;
	values?: Array<{ value?: string; display?: string; description?: string }>;
}

/** Matches from carapace's JSON export; values are unquoted; `n` marks one that takes no trailing space. */
export function parseCarapaceExport(json: string): DriverMatch[] {
	let parsed: CarapaceExport;
	try {
		parsed = JSON.parse(json) as CarapaceExport;
	} catch {
		return [];
	}
	const nospace = parsed.nospace ?? "";
	const out: DriverMatch[] = [];
	for (const each of parsed.values ?? []) {
		const value = each.value ?? "";
		if (!value) continue;
		const last = value.at(-1) ?? "";
		const flags = nospace === "*" || (last && nospace.includes(last)) ? "n" : "";
		out.push({ value, description: each.description ?? "", flags });
	}
	return out;
}

/**
 * Asks carapace for the completions of `words` (the command name first, the word being typed last):
 * `carapace <command> export <command> <args...> <current>`. Undefined when it fails or `signal` aborts.
 */
export function carapaceComplete(
	binary: string,
	words: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<DriverMatch[] | undefined> {
	return new Promise((resolve) => {
		const command = words[0];
		if (!command || options.signal.aborted) return resolve(undefined);
		// execFile does not forward killSignal to spawn's AbortSignal handler; handle cancellation explicitly.
		const onAbort = () => child.kill("SIGKILL");
		const child = execFile(
			binary,
			[command, "export", ...words],
			{
				cwd: options.cwd,
				env: { ...options.env, CARAPACE_LENIENT: "1" },
				maxBuffer: 16 * 1024 * 1024,
				timeout: DEFAULT_TIMINGS.stallMs,
				killSignal: "SIGKILL",
				windowsHide: true,
			},
			(error, stdout) => {
				options.signal.removeEventListener("abort", onAbort);
				resolve(error || options.signal.aborted ? undefined : parseCarapaceExport(stdout));
			},
		);
		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) onAbort();
	});
}
