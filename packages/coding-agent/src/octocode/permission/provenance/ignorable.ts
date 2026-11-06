import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalPath, isWithin } from "../../shared/home/repo.ts";

/**
 * Text that carries no instruction however it got into a report: an existing path inside the workspace, the session's
 * folder, a registered model id. A command repeats them as a matter of course (`cd <cwd> && …`), so a window that
 * lies only in them is not a hit. Every such span is replaced by a character no indexed text holds, so a hit needs a
 * full run of other text: injected prose still trips, and so does a path outside the workspace or one that does not exist.
 */
export interface IgnorableScope {
	cwd: string;
	/** The repository root paths are trusted under; none: only `cwd` and model ids count. */
	root: string | undefined;
	/** Registered models as `provider/id` pairs. */
	models: readonly { provider: string; id: string }[];
}

const MASK = "\u0000";
/** Shorter text cannot fill a window on its own, and a short id would hide ordinary words. */
const MIN_LITERAL = 12;
const MAX_TOKENS = 100;
const MAX_TOKEN = 4096;
const THINKING = /^:(?:off|minimal|low|medium|high|xhigh)\b/;
const PATH_TOKEN = /[^\s"'`<>|&;(){}=,]*\/[^\s"'`<>|&;(){}=,]*/g;

type Span = [start: number, end: number];

function literals(value: string, needle: string, out: Span[], thinking = false): void {
	if (needle.length < MIN_LITERAL) return;
	for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + needle.length)) {
		const end = at + needle.length;
		out.push([at, thinking ? end + (THINKING.exec(value.slice(end))?.[0].length ?? 0) : end]);
	}
}

/** The longest leading run of segments of `token` that names an existing path inside `root`, as its length in `token`. */
function existingPrefix(token: string, cwd: string, root: string): number {
	const absolute = token.startsWith("/");
	const segments = token.split("/");
	for (let count = segments.length; count > (absolute ? 1 : 0); count--) {
		const prefix = segments.slice(0, count).join("/");
		if (prefix === "" || prefix === "." || prefix === "..") continue;
		const file = absolute ? prefix : path.resolve(cwd, prefix);
		if (existsSync(file) && isWithin(canonicalPath(file), root)) return prefix.length;
	}
	return 0;
}

function pathSpans(value: string, scope: IgnorableScope, out: Span[]): void {
	if (scope.root === undefined) return;
	const root = canonicalPath(scope.root);
	let seen = 0;
	for (const match of value.matchAll(PATH_TOKEN)) {
		if (++seen > MAX_TOKENS) return;
		// `file.ts:12:3` and a closing `.` or `:` are not part of the path.
		const token = match[0].replace(/(?::\d+)+$/, "").replace(/[.,:;!?]+$/, "");
		if (token.length > MAX_TOKEN || token.includes("://")) continue;
		const length = existingPrefix(token, scope.cwd, root);
		if (length > 0) out.push([match.index, match.index + length]);
	}
}

/** `value` with its ignorable spans replaced; the same string when it has none. */
export function maskIgnorable(value: string, scope: IgnorableScope): string {
	const spans: Span[] = [];
	literals(value, scope.cwd, spans);
	if (scope.root !== undefined) literals(value, scope.root, spans);
	for (const { provider, id } of scope.models) {
		literals(value, `${provider}/${id}`, spans, true);
		literals(value, id, spans, true);
	}
	pathSpans(value, scope, spans);
	if (spans.length === 0) return value;
	spans.sort((a, b) => a[0] - b[0]);
	let out = "";
	let at = 0;
	for (const [start, end] of spans) {
		if (end <= at) continue;
		out += value.slice(at, Math.max(at, start)) + MASK;
		at = end;
	}
	return out + value.slice(at);
}

/** What a check reads of the session's context: its folder, and the models the user can pick (ids a report may print). */
export interface CheckContext {
	cwd: string;
	modelRegistry?: { getAll(): readonly { provider: string; id: string }[] };
}

/** Whether the user allowed text from this subagent for the session (`provenance/grant.ts`). */
export type AllowedSource = (agent: string) => boolean;
