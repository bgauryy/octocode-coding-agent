import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CallToolResult } from "../../client/index.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { clipText } from "../../../../common/src/clip.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";

/** The package's capture folder inside the session's working directory: the only place a result's files are read from. */
export const CAPTURE_FOLDER = join(".octocode", "octocode-chrome-devtools");
const MAX_LOG_BYTES = 256_000;
const MAX_LINES = 20;
const MAX_CHARS = 2000;
/** Lines every launch writes that say nothing about why a call failed. */
const NOISE = /^\[CDP_SANDBOX\] sandboxed|ExperimentalWarning|^\(Use `node --trace-warnings/;
/** A help text's first line, bare or behind the helper's tag (`[PRUNE] Usage: ...`). */
const USAGE = /^\s*(?:\[[A-Z_]+\]\s*)?usage:/i;

/** The text of a file under the capture folder (symbolic links followed), or undefined for anything else or when unreadable. */
async function readCaptureText(path: unknown, cwd: string): Promise<string | undefined> {
	if (typeof path !== "string") return undefined;
	try {
		const folder = await realpath(join(cwd, CAPTURE_FOLDER));
		const file = await realpath(resolve(cwd, path));
		const inside = relative(folder, file);
		if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
		const info = await stat(file);
		if (!info.isFile()) return undefined;
		const bytes = await readFile(file);
		// A long log keeps its end, where the engine writes the error.
		return bytes.subarray(Math.max(0, info.size - MAX_LOG_BYTES)).toString("utf8");
	} catch {
		return undefined;
	}
}

const tail = (text: string) => clipTail(text.split("\n").filter((line) => line.trim() && !NOISE.test(line)));

/** The last lines of `lines`, at most `MAX_LINES` and `MAX_CHARS` characters; the end is kept because the error comes last. */
function clipTail(lines: string[]): string {
	const kept = lines.slice(-MAX_LINES).join("\n");
	return kept.length > MAX_CHARS ? `…${kept.slice(kept.length - MAX_CHARS + 1)}` : kept;
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** The `failure.error` of the run's `browser-result.json`, when the result names one. */
async function planFailure(structured: Record<string, unknown>, cwd: string): Promise<string | undefined> {
	const direct = field(structured.failure, "error");
	if (typeof direct === "string") return direct;
	if (!Array.isArray(structured.artifacts)) return undefined;
	const root = typeof structured.root === "string" ? structured.root : cwd;
	for (const entry of structured.artifacts) {
		const path = field(entry, "path");
		if (typeof path !== "string" || !/browser-result\.json$/i.test(path)) continue;
		const text = await readCaptureText(resolve(cwd, root, path), cwd);
		try {
			const error = field(field(JSON.parse(text ?? ""), "failure"), "error");
			if (typeof error === "string") return error;
		} catch {
			// Not JSON: no cause to add.
		}
	}
	return undefined;
}

/**
 * What the model needs from the engine's log files, so it does not spend a call to read them. A failed result (`ok:false`
 * or an error) gets the plan's `failure.error` and the last lines of `stderr.txt`; a help result (`--help` prints
 * `Usage: ...`, on stdout or, for some helpers, stderr) gets that text. Each is clipped; undefined when there is nothing to add.
 */
export async function engineDetail(result: CallToolResult, cwd: string): Promise<string | undefined> {
	const structured = result.structuredContent;
	if (!isRecord(structured)) return undefined;
	const logs = isRecord(structured.logs) ? structured.logs : {};
	const failed = result.isError === true || structured.ok === false;
	const [stderr, stdout] = await Promise.all([readCaptureText(logs.stderr, cwd), readCaptureText(logs.stdout, cwd)]);
	const parts: string[] = [];
	if (failed) {
		const cause = await planFailure(structured, cwd);
		if (cause) parts.push(`Failure: ${clipText(cause, MAX_CHARS)}`);
		const errors = stderr === undefined ? "" : tail(stderr);
		if (errors) parts.push(`stderr (last lines):\n${errors}`);
		if (!parts.length && stdout?.trim()) parts.push(`stdout (last lines):\n${tail(stdout)}`);
	} else {
		const help = [stdout, stderr].find((text) => text !== undefined && USAGE.test(text));
		// A helper that saved nothing (`har-pager`, `measure-query`) answers only in stdout.
		const capture = structured.capture;
		const bare = isRecord(capture) && capture.artifacts === 0 && capture.findings === 0;
		const output = help ?? (bare ? stdout : undefined);
		if (output?.trim()) parts.push(`${help ? "Help text" : "Output"}:\n${clipText(output.trim(), MAX_CHARS * 2)}`);
	}
	return parts.length ? visibleControls(parts.join("\n")) : undefined;
}
