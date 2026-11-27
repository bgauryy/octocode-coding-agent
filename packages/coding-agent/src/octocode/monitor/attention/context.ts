import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { prewarmLeadTokens } from "../../../core/agent-session/compaction-prewarm.ts";
import type { CompactionThinking } from "../../../core/compaction/settings.ts";
import type { FeatureContext, SetupPick } from "../../../core/features/index.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { MONITOR_DEFAULTS } from "../../../core/settings-schema/monitor.ts";
import type { Settings } from "../../../core/settings-schema.ts";
import { CONTEXT_NOTICE_TYPE, supersededNotice } from "../../shared/context-notices.ts";
import { autoCompactAt } from "../../shared/tokens.ts";
import { attend } from "./attend.ts";

/**
 * Context usage notices: when the context crosses a band of the room before automatic compaction (by default half, three
 * quarters and nine tenths), the model gets one short message with the tokens used, the room left and what happens at the
 * limit (Anthropic's API sends recent Claude models a remaining-budget update after each tool call; this works for every
 * provider). A notice is an ordinary hidden custom message, so the system prompt stays byte-stable and the notice sits in
 * the transcript where it was sent. The last band noticed is read back from the context, so a resume does not repeat it
 * and a compaction, which summarizes the notices away, starts the bands over.
 */
export { CONTEXT_NOTICE_TYPE };

/** `monitor.contextBands`, sorted; a list with a value outside (0, 1) reads as the default, and `[]` turns notices off. */
export function contextBands(settings: Pick<Settings, "monitor"> | undefined): readonly number[] {
	const bands: unknown = settings?.monitor?.contextBands;
	const valid =
		Array.isArray(bands) &&
		bands.every((band) => typeof band === "number" && Number.isFinite(band) && band > 0 && band < 1);
	return valid ? [...(bands as number[])].sort((a, b) => a - b) : MONITOR_DEFAULTS.contextBands;
}

/** The highest band `tokens` has reached, if any. */
export function noticeBand(
	tokens: number,
	limit: number,
	bands: readonly number[] = MONITOR_DEFAULTS.contextBands,
): number | undefined {
	if (limit <= 0) return undefined;
	return bands.filter((band) => tokens >= band * limit).at(-1);
}

const kilo = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * Only from nine tenths of the room on, and once the context is inside the prewarm lead (`prewarmLeadTokens`), is an
 * agent with the `compact` tool told it may compact at a task boundary: by then automatic compaction is a few turns
 * away and its summary is being written ahead (`early-summary.ts`), so compacting at the boundary moves that
 * compaction there instead of adding one. An earlier hint made agents compact long before the threshold, paying for
 * more lossy summaries. In a window past about 320k tokens nine tenths comes before the lead (which stops at 32k), so
 * the hint waits for the lead: a compaction there would pay for a summary of its own.
 */
const COMPACT_HINT_BAND = 0.9;

/** Whether the notice for `band` at `tokens` offers `compact` (see above). */
const compactHintDue = (band: number, tokens: number, limit: number, window: number): boolean =>
	band >= COMPACT_HINT_BAND && tokens > limit - prewarmLeadTokens(window);

/** Octocode always compacts automatically at the limit (`getCompactionEnabled`). */
export function contextNoticeText(tokens: number, limit: number, window: number, compactHint = false): string {
	const left = Math.max(0, limit - tokens);
	const percent = Math.round((tokens / limit) * 100);
	return renderPrompt("notices/monitor/context-usage.md", {
		used: kilo(tokens),
		limit: kilo(limit),
		percent,
		left: kilo(left),
		window: kilo(window),
		compactHint,
	});
}

/** The band and compact-hint state of the last notice in the context, if any. */
function lastNoticeState(
	messages: readonly { message: unknown }[],
	compactionId?: string,
): { band: number; compactHint: boolean } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index].message;
		if (!isRecord(message) || message.role !== "custom" || message.customType !== CONTEXT_NOTICE_TYPE) continue;
		if (supersededNotice(message, compactionId)) continue;
		// A legacy notice cannot establish occupancy in this new checkpoint; one fresh append upgrades its provenance.
		if (compactionId && (!isRecord(message.details) || message.details.compactionId === undefined)) continue;
		const band = isRecord(message.details) ? message.details.band : undefined;
		if (typeof band !== "number") return undefined;
		const compactHint =
			(isRecord(message.details) && message.details.compactHint === true) ||
			(typeof message.content === "string" && message.content.includes("`compact`"));
		return { band, compactHint };
	}
	return undefined;
}

/** The band of the last notice in the context, if any. */
export function lastNoticedBand(messages: readonly { message: unknown }[], compactionId?: string): number | undefined {
	return lastNoticeState(messages, compactionId)?.band;
}

/**
 * After a turn: sends a notice when the context reached a band higher than the last one noticed, or entered the prewarm
 * lead where `compact` becomes actionable after an earlier 0.9 notice on a large window. It never starts a turn; during
 * a run it joins the context at the end of the turn, before the next request. Returns the send, or undefined when nothing is due.
 */
export function noticeContextUsage(
	api: SetupPick<"session", "sendMessage">,
	ctx: Pick<FeatureContext, "model" | "getContextUsage">,
	messages: readonly { message: unknown }[],
	thinking?: CompactionThinking,
	compactTool = false,
	compactionId?: string,
	bands: readonly number[] = MONITOR_DEFAULTS.contextBands,
): Promise<boolean> | undefined {
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens;
	// The window and threshold are the ones the footer and `/context` show (overrides, routed and virtual models).
	const window = usage?.contextWindow ?? model?.contextWindow;
	if (!model || !window || window <= 0 || typeof tokens !== "number") return undefined;
	const limit = usage?.compactionThreshold ?? autoCompactAt({ ...model, contextWindow: window }, thinking);
	if (limit <= 0) return undefined;
	const band = noticeBand(tokens, limit, bands);
	if (band === undefined) return undefined;
	const hint = compactTool && compactHintDue(band, tokens, limit, window);
	const last = lastNoticeState(messages, compactionId);
	if (last !== undefined && last.band >= band && (!hint || last.compactHint)) return undefined;
	return attend(
		api,
		{ rule: "context", value: Math.round((tokens / limit) * 100), threshold: Math.round(band * 100) },
		{
			customType: CONTEXT_NOTICE_TYPE,
			content: contextNoticeText(tokens, limit, window, hint),
			details: { band, tokens, limit, compactHint: hint, compactionId: compactionId ?? null },
		},
		{ how: "note" },
	);
}
