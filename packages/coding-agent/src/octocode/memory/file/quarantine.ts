import { storedText } from "@octocodeai/octocode-common/sanitize";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { normalize, shingles, URL_PATTERN } from "../../permission/provenance/keys.ts";
import { untrustedResultOrigin } from "../../permission/result-origin.ts";
import { contentText } from "../../shared/util.ts";
import { jaccard, stem, terms } from "../query.ts";

/**
 * What keeps text from outside out of the MEMORY.md files when no person wrote it (a background pass): a planted line
 * would reach every later session. A line is quarantined, kept only as a flagged candidate, when it names a URL, tells
 * tools what to run or to skip asking, or mostly repeats tool output the session read from outside: the web, an MCP
 * server (another repository's files among them), a network command. The match uses the provenance tripwire's text
 * windows (`permission/provenance/keys.ts`), so a paraphrase gets past it; the other rules and the user's own review
 * of the file are the rest of the defense. A user's explicit save goes through the permission gate instead.
 */

/** Share of a line's text windows found in untrusted output at which the line counts as drawn from it. */
const TAINT_SHARE = 0.5;
/** Word overlap with a quarantined candidate at which a proposed line counts as that candidate again. */
const QUARANTINED_JACCARD = 0.5;
/** Untrusted output read per result and in all; past it the rest of the session is not indexed. */
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_TOTAL_CHARS = 4 * 1024 * 1024;

/** An imperative aimed at a tool, a command or a URL. */
const TOOL_IMPERATIVE =
	/\b(?:run|execute|exec|call|invoke|fetch|download|pipe|source|eval|install|upload|post|send|open|visit|browse)\b[^.;:]{0,60}\b(?:curl|wget|https?|sh\s+-c|bash\s+-c|\|\s*(?:ba|z)?sh\b|powershell|iex|eval|base64|netcat|nc|ssh|scp|mcp__\w+|the\s+web\b|web\s+tool)/i;
/** A line that would loosen the rules or the user's control. */
const OVERRIDE =
	/\b(?:ignore|disregard|forget|override|bypass)\b[^.;]{0,40}\b(?:instructions?|rules?|polic(?:y|ies)|AGENTS\.md|system|permissions?|approvals?|safety|guardrails?)\b|\b(?:without|skip(?:ping)?)\s+(?:asking|approval|permission|confirmation)\b|\bauto-?approve\b/i;

/** Where the session read text from outside, as text windows (hashes only) with the label of their source. */
export interface Taint {
	/** The source most of `text` repeats, or undefined. */
	sourceOf(text: string): string | undefined;
}

/** The untrusted tool output of `entries` (a session's branch), indexed for `quarantineReason`. */
export function sessionTaint(entries: readonly SessionEntry[]): Taint {
	const inputs = new Map<string, unknown>();
	const windows = new Map<number, string>();
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || total >= MAX_TOTAL_CHARS) continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") inputs.set(part.id, part.arguments);
			continue;
		}
		if (message.role !== "toolResult") continue;
		const label = untrustedResultOrigin(message.toolName, inputs.get(message.toolCallId), message.details);
		if (!label) continue;
		const text = normalize(contentText(message.content)).slice(0, MAX_RESULT_CHARS);
		total += text.length;
		for (const key of shingles(text)) if (!windows.has(key)) windows.set(key, label);
	}
	return {
		sourceOf(text) {
			const keys = shingles(normalize(text));
			if (keys.length === 0 || windows.size === 0) return undefined;
			const hits = keys.filter((key) => windows.has(key));
			return hits.length / keys.length >= TAINT_SHARE ? windows.get(hits[0]) : undefined;
		},
	};
}

/** No session to check against: a pass that runs for another session's candidates. */
export const NO_TAINT: Taint = { sourceOf: () => undefined };

/**
 * Why `text`, proposed by a background pass, must not be written, or undefined. `quarantined` are the texts of
 * candidates already quarantined: a pass that restates one is quarantined too.
 */
export function quarantineReason(text: string, taint: Taint, quarantined: readonly string[] = []): string | undefined {
	const clean = storedText(text);
	if (new RegExp(URL_PATTERN.source, "i").test(clean)) return "names a URL";
	if (TOOL_IMPERATIVE.test(clean)) return "tells tools what to run or fetch";
	if (OVERRIDE.test(clean)) return "would loosen the rules or skip the user's approval";
	const source = taint.sourceOf(clean);
	if (source) return `mostly repeats what ${source} returned`;
	const words = [...new Set(terms(clean).map(stem))];
	if (
		words.length > 0 &&
		quarantined.some((other) => jaccard(words, [...new Set(terms(other).map(stem))]) >= QUARANTINED_JACCARD)
	)
		return "restates a quarantined candidate";
	return undefined;
}
