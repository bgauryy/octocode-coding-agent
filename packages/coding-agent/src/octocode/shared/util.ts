import { activeRates, type ModelCost, type Usage } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import type { FeatureContext } from "../../core/features/index.ts";
import { truncateHead } from "../../core/tools/index.ts";
import { formatBytes } from "@octocodeai/octocode-common/bytes";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { RESULT_DEFAULT_BYTES, RESULT_DEFAULT_LINES } from "../../utils/output-budget.ts";
import { cutText } from "@octocodeai/octocode-common/text";
import { clipText, firstLine } from "@octocodeai/octocode-common/clip";

interface TextResult<T = unknown> {
	content: Array<{ type: "text"; text: string }>;
	details: T;
}

export function textResult<T = undefined>(text: string, details?: T): TextResult<T> {
	return { content: [{ type: "text", text }], details: details as T };
}

/** `12 of 40 lines (3.0KB of 90KB)`: the counts both output notes state (`ELISION_MARKER` finds them). */
export const trimmedCounts = (shownLines: number, totalLines: number, shownBytes: number, totalBytes: number): string =>
	`${shownLines} of ${totalLines} lines (${formatBytes(shownBytes, "compact")} of ${formatBytes(totalBytes, "compact")})`;

/** Keep tool output inside Octocode's per-result budget and say when it was cut. */
export function capOutput(text: string, maxBytes = RESULT_DEFAULT_BYTES, maxLines = RESULT_DEFAULT_LINES): string {
	const cut = truncateHead(text, { maxBytes, maxLines });
	if (!cut.truncated) return cut.content;
	if (cut.content === "" && text !== "") {
		// Octocode keeps whole lines only, so a first line over the byte budget would leave nothing: keep its head instead.
		const head = cutText(text, maxBytes);
		return `${head}\n\n[Output trimmed: the first line alone is ${formatBytes(Buffer.byteLength(firstLine(text)), "compact")}; kept its first ${formatBytes(Buffer.byteLength(head), "compact")} (${formatBytes(cut.totalBytes, "compact")} in all).]`;
	}
	return `${cut.content}\n\n[Output trimmed: ${trimmedCounts(cut.outputLines, cut.totalLines, cut.outputBytes, cut.totalBytes)}.]`;
}

export { clipText, firstLine };

/** Whole seconds in `ms`, rounded: the unit of a job's runtime and of a timeout in messages. */
export const wholeSeconds = (ms: number): number => Math.round(ms / 1000);

/**
 * Waits for `work` to settle, `ms` to pass (no limit when undefined), or `signal` to abort, whichever comes first; never rejects. The timer and
 * the abort listener are removed afterwards, so repeated waits on a long-lived signal leave nothing behind.
 */
export async function settleWithin(
	work: Promise<unknown>,
	ms: number | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			work.catch(() => undefined),
			...(ms === undefined
				? []
				: [
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, ms);
							return undefined;
						}),
					]),
			...(signal
				? [
						new Promise<void>((resolve) => {
							onAbort = () => resolve();
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]
				: []),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * The placeholders Octocode leaves where it cut text the model later sees: `capChars` cuts, the gap and trim note of a
 * result spilled to a file (`capOutput`, `capOutputToFile`), the range note of a file read back after compaction, and
 * the cuts of a kept user message or a tool result in a compaction summary. A model that copies one into a file writes
 * a hole, not content.
 */
const ELISION_MARKER =
	/\[… (?:\d+ (?:more characters cut|characters of this message are left out here|characters in the middle left out for the summary|lines? omitted …)|[\d.]+[KM]?B omitted …|shown lines \d+–\d+ of \d+)[^\]\n]*\]|\[Output trimmed: [^\]\n]*\]/g;

export function elisionMarkers(text: string): string[] {
	return text.match(ELISION_MARKER) ?? [];
}

/** `text` parsed as JSON, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `text` cut to `max` characters with a note saying how much was cut (and, optionally, what to do instead). */
export function capChars(text: string, max: number, hint?: string): string {
	if (text.length <= max) return text;
	const kept = cutText(text, max, { chars: true });
	return `${kept}\n[… ${text.length - kept.length} more characters cut${hint ? `; ${hint}` : ""}]`;
}

/**
 * The text of a message or tool result's content (a string, or an array of `{type:'text',text}` parts), joined by
 * `separator`. Image parts become `image` when given, else nothing.
 */
export function contentText(content: unknown, options: { separator?: string; image?: string } = {}): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part): string[] => {
			const text = partText(part);
			if (text !== undefined) return [text];
			return isRecord(part) && part.type === "image" && options.image !== undefined ? [options.image] : [];
		})
		.join(options.separator ?? "\n");
}

/** The text of a `{type:'text',text}` content part, else undefined (an image, a tool call, anything else). */
export function partText(part: unknown): string | undefined {
	return isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined;
}

/** `value` when it is a string, else an empty string: the untyped field a caller reads as text. */
export const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

/** `value` when it is a string, else undefined: tells a missing or mistyped field from an empty one. */
export const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** `value` when it is a finite number, else undefined (not 0, so a missing count is not read as zero). */
export const finiteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `value` when it is an array of strings, else undefined. */
export const stringList = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

export { MINUTE_MS, HOUR_MS, DAY_MS } from "@octocodeai/octocode-common/time";

/** Octocode's wording for a feature context used after its session was replaced or reloaded. */
const STALE_SESSION = "stale after session replacement";

/** Whether `error` says a session context is stale (Octocode gives no error class for it). */
export function isStaleSessionError(error: unknown): boolean {
	return errorMessage(error).includes(STALE_SESSION);
}

export function emptyUsage(): Usage {
	return createEmptyUsage();
}

/** `value` when it is a finite number, else 0. */
export const finiteOrZero = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Add a model response's usage into `total`. Anything that is not a number counts as zero. */
export function addUsage(total: Usage, usage: unknown): void {
	if (!isRecord(usage)) return;
	total.input += finiteOrZero(usage.input);
	total.output += finiteOrZero(usage.output);
	total.cacheRead += finiteOrZero(usage.cacheRead);
	total.cacheWrite += finiteOrZero(usage.cacheWrite);
	for (const key of ["cacheWrite1h", "cacheWrite12h", "cacheWrite30m", "reasoning"] as const) {
		if (typeof usage[key] === "number" && Number.isFinite(usage[key])) total[key] = (total[key] ?? 0) + usage[key];
	}
	if (usage.lowerBound === true) total.lowerBound = true;
	total.totalTokens += finiteOrZero(usage.totalTokens);
	const cost = asRecord(usage.cost);
	total.cost.input += finiteOrZero(cost.input);
	total.cost.output += finiteOrZero(cost.output);
	total.cost.cacheRead += finiteOrZero(cost.cacheRead);
	total.cost.cacheWrite += finiteOrZero(cost.cacheWrite);
	total.cost.total += finiteOrZero(cost.total);
}

/**
 * Usage as the displays show it (footer, agents panel, `coordinate list`, subagent rows): `input` is every prompt token
 * (uncached input, cache reads and writes), `cacheRead` the part of it read from cache, `cost` the sum of Octocode's per-reply
 * estimate, and `unpriced` whether any reply came from a model without pricing (its tokens are missing from `cost`).
 */
export interface UsageTotals {
	input: number;
	cacheRead: number;
	/** The part of `input` written to cache. */
	cacheWrite?: number;
	output: number;
	cost: number;
	unpriced: boolean;
}

export const emptyTotals = (): UsageTotals => ({
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

/** A message that carries spend, shaped as a reply: `usage`, and `details.unpriced` when a subagent run judged its replies. */
export interface Spend {
	role: string;
	usage: Record<string, unknown>;
	details?: unknown;
	provider?: unknown;
	model?: unknown;
}

/**
 * The spend a message carries, or undefined: a model reply's `usage`, a tool result's (a foreground subagent's `agent`
 * result), or a custom message's `details.usage` (a background subagent's report: the run's total, with
 * `details.unpriced`). Every display and the session index count exactly these.
 */
export function spendOf(message: unknown): Spend | undefined {
	if (!isRecord(message) || typeof message.role !== "string") return undefined;
	const role = message.role;
	if ((role === "assistant" || role === "toolResult") && isRecord(message.usage)) return message as unknown as Spend;
	const details = message.details;
	if (role === "custom" && isRecord(details) && isRecord(details.usage))
		return { role, usage: details.usage, details: { unpriced: details.unpriced === true } };
	return undefined;
}

/** The message a session entry adds to the context (a `message` entry's, or a `custom_message` entry as a custom message), else undefined. */
export function entryMessage(entry: unknown): unknown {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, details: entry.details };
	return undefined;
}

/** Adds one reply's usage (anything that is not a number counts as zero); `unpriced` from `unpricedModel`. */
export function addReply(totals: UsageTotals, usage: unknown, unpriced: boolean): void {
	if (!isRecord(usage)) return;
	totals.input += finiteOrZero(usage.input) + finiteOrZero(usage.cacheRead) + finiteOrZero(usage.cacheWrite);
	totals.cacheRead += finiteOrZero(usage.cacheRead);
	totals.cacheWrite = (totals.cacheWrite ?? 0) + finiteOrZero(usage.cacheWrite);
	totals.output += finiteOrZero(usage.output);
	totals.cost += finiteOrZero(isRecord(usage.cost) ? usage.cost.total : undefined);
	if (unpriced) totals.unpriced = true;
}

/** A model's registry rates by provider and id (`ctx.modelRegistry.find`); undefined when the registry does not know it. */
export type ModelLookup = (provider: string, id: string) => { cost?: ModelCost } | undefined;

/** Cache registry results only for one synchronous history pass; pricing still resolves for each reply's timestamp. */
export function memoizedModelLookup(find: ModelLookup): ModelLookup {
	const providers = new Map<string, Map<string, ReturnType<ModelLookup>>>();
	return (provider, id) => {
		let models = providers.get(provider);
		if (!models) providers.set(provider, (models = new Map()));
		if (!models.has(id)) models.set(id, find(provider, id));
		return models.get(id);
	};
}

export const modelLookup =
	(ctx: Pick<FeatureContext, "modelRegistry">): ModelLookup =>
	(provider, id) =>
		ctx.modelRegistry?.find(provider, id);

/**
 * The `provider/model` of a reply (an assistant message, or a tool result carrying a subagent's usage) that spent tokens
 * on a model without pricing, else undefined. Octocode gives a model with no `cost` in models.json all-zero rates, so its usage
 * silently costs $0: free local models, or a model nobody priced. A model the registry does not know (or a reply that does
 * not name one) is judged by the reply's own cost.
 */
export function unpricedModel(message: unknown, find?: ModelLookup): string | undefined {
	if (!isRecord(message) || !isRecord(message.usage)) return undefined;
	const usage = message.usage;
	if (
		finiteOrZero(usage.input) +
			finiteOrZero(usage.output) +
			finiteOrZero(usage.cacheRead) +
			finiteOrZero(usage.cacheWrite) ===
		0
	)
		return undefined;
	// A subagent's `agent` result names no model; its run already judged every reply (partly priced is still unpriced).
	const details = isRecord(message.details) ? message.details : undefined;
	if (typeof details?.unpriced === "boolean" && typeof message.model !== "string") {
		return details.unpriced ? (typeof details.model === "string" ? details.model : "a subagent model") : undefined;
	}
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	const cost = provider && model ? find?.(provider, model)?.cost : undefined;
	// The rates in effect when the reply was billed: an expired free introductory price no longer makes a model free.
	const rates = cost
		? activeRates(cost, typeof message.timestamp === "number" ? message.timestamp : Date.now())
		: undefined;
	const free = rates
		? rates.input === 0 && rates.output === 0 && rates.cacheRead === 0 && rates.cacheWrite === 0
		: finiteOrZero(isRecord(usage.cost) ? usage.cost.total : undefined) === 0;
	if (!free) return undefined;
	return model ? (provider ? `${provider}/${model}` : model) : "unknown model";
}
