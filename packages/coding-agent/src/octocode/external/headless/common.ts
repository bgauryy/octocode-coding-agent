import path from "node:path";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { clip } from "../../shared/text.ts";
import { HeadlessSignedOut } from "./types.ts";

export const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A vendor session id as the CLIs print it (a UUID or a short token): never an option, so it cannot reach argv as a flag. */
export const isSessionId = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);

export const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The input fields that name what a tool acts on, in the order a row line prefers them. */
const TARGET_FIELDS = [
	"file_path",
	"notebook_path",
	"absolute_path",
	"command",
	"pattern",
	"dir_path",
	"path",
	"filePath",
	"url",
	"query",
	"description",
];

/** What a tool call acts on, from its input: the first target field, shown relative to the task folder. */
export function targetOf(input: unknown, roots: readonly string[]): string {
	if (!isRecord(input)) return "";
	const field = TARGET_FIELDS.find((key) => typeof input[key] === "string" && input[key]);
	let target = field ? String(input[field]) : "";
	const root = path.isAbsolute(target) ? roots.find((each) => target.startsWith(`${each}${path.sep}`)) : undefined;
	if (root) target = path.relative(root, target);
	return target;
}

/** A tool call as one short row line, like an ACP `tool_call` title: the tool and what it acts on. */
export const toolRow = (name: string, target: string): string =>
	`→ ${clip(redactSecrets(target ? `${name} ${target}` : name), 120)}`;

/** An action the CLI refused or that failed, as one row line. */
export const deniedRow = (what: string): string => `✗ ${clip(redactSecrets(what), 80)}`;

/** Token totals: `inputTokens` excludes cached reads and writes, which are reported apart, as ACP turns report them. */
export function totals(inputTokens: number, outputTokens: number, cachedRead = 0, cachedWrite = 0): ExternalUsage {
	return {
		inputTokens,
		outputTokens,
		...(cachedRead ? { cachedReadTokens: cachedRead } : {}),
		...(cachedWrite ? { cachedWriteTokens: cachedWrite } : {}),
		totalTokens: inputTokens + outputTokens + cachedRead + cachedWrite,
	};
}

/** A turn that ended in failure: signed out (matching `signedOut`) or an error naming the cause. */
export function failTurn(runner: string, detail: string, signedOut: RegExp): never {
	const why = redactSecrets(detail.trim()) || "no detail";
	if (signedOut.test(why)) throw new HeadlessSignedOut(why);
	throw new Error(`${runner} (headless) failed: ${why}`);
}

/** A run that ended without its terminal event: the stderr tail, or the exit code, says why. */
export function endedWithout(runner: string, code: number | null, stderr: string, signedOut: RegExp): never {
	const why = redactSecrets(stderr.trim()) || `exit code ${code}`;
	if (signedOut.test(why)) throw new HeadlessSignedOut(why);
	throw new Error(`${runner} (headless) ended without a result: ${why}`);
}
