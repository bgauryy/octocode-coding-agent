import type { Item } from "./item.ts";
import type { CompletionArgument } from "./completion-key.ts";

/** The fields whose value is a list; a model sometimes sends the list as JSON text. */
const LIST_KEYS = [
	"items",
	"paths",
	"tags",
	"evidence",
	"dependsOn",
	"ids",
	"states",
	"dependingOn",
	"touchingPaths",
	"anyTag",
] as const;
/** The fields whose value is an object; same mistake. */
const OBJECT_KEYS = ["completion", "close"] as const;

/** `text` parsed once when it is JSON of the wanted container kind; undefined otherwise (the caller keeps the text). */
function parsed(text: string, kind: "array" | "object"): unknown {
	if (!/^\s*[[{]/.test(text)) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (value === null || typeof value !== "object") return undefined;
		return Array.isArray(value) === (kind === "array") ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The call's arguments with list and object fields that arrived as JSON text (`"items": "[{...}]"`) parsed once. A
 * string that is not JSON of that kind stays as sent, so validation reports it.
 */
export function parseJsonStrings<T extends object>(args: T): T {
	const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
	for (const [keys, kind] of [
		[LIST_KEYS, "array"],
		[OBJECT_KEYS, "object"],
	] as const) {
		for (const key of keys) {
			const value = out[key];
			const list = typeof value === "string" ? parsed(value, kind) : undefined;
			if (list !== undefined) out[key] = list;
		}
	}
	return out as T;
}

/** Item ids written as one string: `B1, B2`, `B1 B2` or `B1,B2`. */
export function splitIds(text: string): string[] {
	return text.split(/[\s,]+/).filter(Boolean);
}

const COMPLETION_KEYS = ["summary", "verification", "files", "lesson", "operationKey", "replaces", "receipt"];
const STATUSES = ["passed", "failed", "not_run", "not_applicable", "not_stated"];
type Status = "passed" | "failed" | "not_run" | "not_applicable" | "not_stated";
const NEEDS =
	"completion needs summary (what was done) and verification (what ran and its result), e.g. {summary, verification, files: [paths]}";

const PASS_WORD = /\b(pass(ed|es|ing)?|green|succeed(ed|s)?|success(ful(ly)?)?)\b/;
/** Words that put a pass in doubt ("2 failed", "did not pass"); "no failures" and "0 errors" are removed first. */
const NO_FAILURE = /\b(no|0|zero|without)\s+(\w+\s+)?(fail\w*|errors?)\b/g;
const DOUBT = /\b(fail\w*|errors?|not|never|skipp\w*)\b|n't/;

/**
 * The status a one-sentence verification states: in its first words, else a pass it names after what ran ("yarn test:
 * 12 passed") with nothing that puts it in doubt. A sentence that names no status is `not_stated`, never passed.
 */
function statusOf(text: string): Status {
	const lead = text.trim().toLowerCase();
	if (/^(not applicable|n\/a|no check applies|nothing (to|can) (run|verify))/.test(lead)) return "not_applicable";
	if (/^(failed|failing)\b/.test(lead)) return "failed";
	if (/^(not run|not verified|unverified)/.test(lead)) return "not_run";
	if (/^(pass(ed|es)?|ok|green|verified|success|succeeded)\b/.test(lead)) return "passed";
	const rest = lead.replace(NO_FAILURE, "");
	return PASS_WORD.test(rest) && !DOUBT.test(rest) ? "passed" : "not_stated";
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const receiptRef = (value: unknown): string => {
	if (!text(value))
		throw new Error('completion.receipt must be a receipt id from a verify: true bash result, or "latest".');
	return value.trim();
};

/**
 * A completion as the model may write it, mapped to the stored shape (`CompletionSchema`). Light form: `verification` is
 * one sentence whose status `statusOf` reads (not stated when it names none) and `files` are paths (role
 * changed). The stored form (`verification: {status, summary}`, `files: [{path, role}]`) is accepted unchanged. Errors
 * name the key in plain words, before the store's own checks.
 */
export function completionInput(value: unknown): CompletionArgument {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`completion must be an object: ${NEEDS}.`);
	const given = value as Record<string, unknown>;
	const unknown = Object.keys(given).filter((key) => !COMPLETION_KEYS.includes(key));
	if (unknown.length)
		throw new Error(
			`Unknown completion fields: ${unknown.join(", ")}. Use summary, verification, files, lesson, receipt.`,
		);
	if (!text(given.summary)) throw new Error(`completion.summary is missing: ${NEEDS}.`);
	const check = given.verification;
	let verification: CompletionArgument["verification"];
	if (text(check)) verification = { status: statusOf(check), summary: check };
	else if (check && typeof check === "object" && !Array.isArray(check)) {
		const { status, summary, ...extra } = check as Record<string, unknown>;
		if (Object.keys(extra).length)
			throw new Error(
				`Unknown completion.verification fields: ${Object.keys(extra).join(", ")}. Use status and summary.`,
			);
		if (typeof status !== "string" || !STATUSES.includes(status))
			throw new Error(`completion.verification.status must be one of ${STATUSES.join(", ")}.`);
		if (!text(summary)) throw new Error("completion.verification.summary is missing: say what ran and its result.");
		verification = { status: status as never, summary };
	} else throw new Error(`completion.verification is missing: ${NEEDS}.`);
	const files = given.files ?? [];
	if (!Array.isArray(files)) throw new Error('completion.files must be a list of paths, e.g. ["src/a.ts"].');
	return {
		summary: given.summary,
		files: files.map((file) =>
			typeof file === "string" ? { path: file, role: "changed" } : { role: "changed", ...file },
		),
		verification,
		...(given.lesson !== undefined ? { lesson: given.lesson as string } : {}),
		...(given.operationKey !== undefined ? { operationKey: given.operationKey as string } : {}),
		...(given.replaces !== undefined ? { replaces: given.replaces as number } : {}),
		...(given.receipt !== undefined ? { receipt: receiptRef(given.receipt) } : {}),
	};
}

/**
 * The completion that closes an epic whose items are all done or closed, when the call said only `state: done`: the
 * epic has no work of its own to verify, so the record names its items and says so.
 */
export function epicCompletion(children: readonly Item[]): CompletionArgument {
	const names = [...children]
		.sort((a, b) => a.seq - b.seq)
		.slice(0, 8)
		.map((child) => child.ref);
	const more = children.length > names.length ? ` and ${children.length - names.length} more` : "";
	return {
		summary: `All ${children.length} items are done or closed: ${names.join(", ")}${more}.`,
		files: [],
		verification: { status: "not_applicable", summary: "Closed from its items; each carries its own verification." },
	};
}
