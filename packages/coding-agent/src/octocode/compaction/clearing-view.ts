import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { renderPrompt } from "../../core/prompt-template.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";
import { CLEARED_RESULTS_TYPE } from "../shared/cleared-results.ts";
import { savedHandle } from "../shared/heap-index.ts";
import { shownLine } from "../sessions/store.ts";

/**
 * How a clearing decision (`clearing.ts`) shows in every request: each cleared result as a placeholder naming its saved
 * copy and, when the decision recorded one, a one-line digest of what it held; each cleared `file` call with its
 * payload strings replaced by their size and hash. Everything shown comes from the decision entry and the stored
 * messages, never from the clock, so every request (and a resume) shows the same bytes.
 */

export const PLACEHOLDER_START = "[Old tool result cleared";

/** What stands for a cleared result; `saved` is where `saveContentCopy` put its whole text, `digest` what it held (`resultDigest`). */
export function clearedPlaceholder(saved: string, digest?: string): string {
	const held = digest ? ` (${digest})` : "";
	return `${PLACEHOLDER_START} to save context${held}. Full output: ${saved} (${savedHandle(saved)}). Read that file, or run the call again.]`;
}

/** Files a digest names; the rest is a count. */
const DIGEST_FILES = 3;
/** Characters kept of each file a digest names. */
const DIGEST_PATH_CHARS = 60;
/** Characters kept of the first non-blank line a digest quotes when the result held no search hits. */
export const DIGEST_LEAD_CHARS = 100;
/** A search hit line: `path:line:` or `path:line-` (grep, rg and the local search tools print these). */
const HIT_LINE = /^([^\s:]{1,300}):(\d+)[:-]/;

/**
 * A deterministic one-line digest of a result's `text`: its line count, a shell command's exit code, and for a result of
 * the user's own workspace (`trusted`) the search hits it held by file, or else its first non-blank line (capped), so the model can tell whether it needs the
 * result back before reading it. An untrusted result (web, MCP, network) gets counts only: none of its text reaches the
 * placeholder, which is not fenced.
 */
export function resultDigest(text: string, tool: string, details: unknown, trusted: boolean): string {
	const lines = text === "" ? 0 : text.split("\n").length;
	const parts = [`${lines} line${lines === 1 ? "" : "s"}`];
	if (tool === "bash" && isRecord(details) && typeof details.exitCode === "number")
		parts.push(`exit ${details.exitCode}`);
	if (trusted) {
		const hits = new Map<string, number>();
		for (const line of text.split("\n")) {
			const file = HIT_LINE.exec(line)?.[1];
			if (file) hits.set(file, (hits.get(file) ?? 0) + 1);
		}
		const total = [...hits.values()].reduce((sum, count) => sum + count, 0);
		if (total >= 2) {
			const named = [...hits.keys()].slice(0, DIGEST_FILES).map((file) => shownLine(file, DIGEST_PATH_CHARS));
			const more = hits.size > DIGEST_FILES ? `, +${hits.size - DIGEST_FILES} more` : "";
			parts.push(`${total} hits in ${hits.size} file${hits.size === 1 ? "" : "s"}: ${named.join(", ")}${more}`);
		} else {
			const lead = text.split("\n").find((line) => line.trim() !== "");
			if (lead !== undefined) parts.push(`starts ${JSON.stringify(shownLine(lead.trim(), DIGEST_LEAD_CHARS))}`);
		}
	}
	return parts.join("; ");
}

/** `messages` with every result in `cleared` replaced by its placeholder (with its digest from `digests`); the same list when none is. */
export function applyClearedResults<T>(
	messages: T[],
	cleared: ReadonlyMap<string, string>,
	digests: ReadonlyMap<string, string> = new Map(),
): T[] {
	if (cleared.size === 0) return messages;
	return messages.map((message) => {
		if (!isRecord(message) || message.role !== "toolResult") return message;
		const id = String(message.toolCallId);
		const saved = cleared.get(id);
		return saved === undefined
			? message
			: { ...message, content: [{ type: "text", text: clearedPlaceholder(saved, digests.get(id)) }] };
	});
}

/** A payload string shorter than this stays: its placeholder would be about as long. */
const PAYLOAD_MIN_CHARS = 160;

/** The payload strings of a `file` call's arguments that clearing replaces: written content, edit texts and a patch. */
function payloadFields(args: unknown, visit: (text: string) => string): unknown {
	if (!isRecord(args)) return args;
	const field = (value: unknown) =>
		typeof value === "string" && value.length >= PAYLOAD_MIN_CHARS ? visit(value) : value;
	const edit = (value: unknown) =>
		isRecord(value) ? { ...value, oldText: field(value.oldText), newText: field(value.newText) } : value;
	const query = (value: unknown) =>
		isRecord(value)
			? {
					...value,
					...(value.content === undefined ? {} : { content: field(value.content) }),
					...(Array.isArray(value.edits) ? { edits: value.edits.map(edit) } : {}),
				}
			: value;
	return {
		...args,
		...(Array.isArray(args.queries) ? { queries: args.queries.map(query) } : {}),
		...(args.patch === undefined ? {} : { patch: field(args.patch) }),
	};
}

/** The text a `file` call's arguments carry that clearing would replace, joined: what clearing it saves. */
export function fileInputText(args: unknown): string {
	const texts: string[] = [];
	payloadFields(args, (text) => {
		texts.push(text);
		return text;
	});
	return texts.join("\n");
}

/** What stands for one cleared payload string: its size and hash, and where its change is. */
function clearedPayload(text: string): string {
	return renderPrompt("notices/compaction/cleared-payload.md", { chars: text.length, sha: sha256(text).slice(0, 12) });
}

/** `messages` with the payload of every `file` call in `inputs` replaced (`clearedPayload`); the same list when none is. */
export function applyClearedInputs<T>(messages: T[], inputs: { readonly size: number; has(id: string): boolean }): T[] {
	if (inputs.size === 0) return messages;
	let changed = false;
	const out = messages.map((message) => {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
		let touched = false;
		const content = message.content.map((part: unknown) => {
			if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || !inputs.has(part.id))
				return part;
			touched = true;
			return { ...part, arguments: payloadFields(part.arguments, clearedPayload) };
		});
		if (!touched) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? out : messages;
}

interface ClearedView {
	/** The `file` calls whose payload is cleared, by tool call id, with when (epoch ms; for stale thinking). */
	inputs: Map<string, number>;
	/** The digest recorded for each cleared result, by tool call id. */
	digests: Map<string, string>;
}

/** Adds what one `CLEARED_RESULTS_TYPE` entry recorded besides the saved copies (`files/reads.ts` folds those). */
function noteView(view: ClearedView, entry: unknown): void {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CLEARED_RESULTS_TYPE || !isRecord(entry.data))
		return;
	const { inputs, results } = entry.data;
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (Array.isArray(inputs))
		for (const id of inputs) if (typeof id === "string") view.inputs.set(id, Number.isNaN(at) ? 0 : at);
	if (Array.isArray(results))
		for (const result of results)
			if (isRecord(result) && typeof result.id === "string" && typeof result.digest === "string")
				view.digests.set(result.id, result.digest);
}

const viewIndex = new BranchIndex<ClearedView>(() => ({ inputs: new Map(), digests: new Map() }), noteView);

/** The cleared `file` payloads and result digests on the session's current branch (read-only: it is shared state). */
export function sessionClearedView(session: BranchSource): Readonly<ClearedView> {
	return viewIndex.read(session);
}
