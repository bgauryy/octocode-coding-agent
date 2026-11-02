import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { MessageRef } from "../files/reads.ts";
import type { CompactionThinking } from "../../core/compaction/settings.ts";
import { autoCompactAt } from "../shared/tokens.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Context usage notices: when the context crosses half, three quarters and nine tenths of the room before automatic
 * compaction, the model gets one short message with the tokens used, the room left and what happens at the limit
 * (Anthropic's API sends recent Claude models a remaining-budget update after each tool call; this works for every
 * provider). A notice is an ordinary hidden custom message, so the system prompt stays byte-stable and the notice sits
 * in the transcript where it was sent. The last band noticed is read back from the context, so a resume does not
 * repeat it and a compaction, which summarizes the notices away, starts the bands over.
 */
export const CONTEXT_NOTICE_TYPE = "octocode-context-usage";

/** Shares of the room before automatic compaction (window less reserve) that each get one notice. */
const CONTEXT_NOTICE_BANDS = [0.5, 0.75, 0.9] as const;

/** The highest band `tokens` has reached, if any. */
export function noticeBand(tokens: number, limit: number): number | undefined {
	if (limit <= 0) return undefined;
	return CONTEXT_NOTICE_BANDS.filter((band) => tokens >= band * limit).at(-1);
}

const kilo = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** From this band on, an agent with the `compact` tool is told it can compact at a task boundary. */
const COMPACT_HINT_BAND = 0.75;

/** Octocode always compacts automatically at the limit (`getCompactionEnabled`). */
export function contextNoticeText(tokens: number, limit: number, window: number, compactHint = false): string {
	const left = Math.max(0, limit - tokens);
	const percent = Math.round((tokens / limit) * 100);
	const hint = compactHint ? " At a task boundary, `compact` can summarize sooner." : "";
	return `[Context] ${kilo(tokens)} of ${kilo(limit)} usable tokens used (${percent}%); about ${kilo(left)} left before automatic compaction summarizes older turns. The window is ${kilo(window)}.${hint}`;
}

/** The band of the last notice in the context, if any. */
export function lastNoticedBand(messages: readonly Pick<MessageRef, "message">[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index].message;
		if (!isRecord(message) || message.role !== "custom" || message.customType !== CONTEXT_NOTICE_TYPE) continue;
		const band = isRecord(message.details) ? message.details.band : undefined;
		return typeof band === "number" ? band : undefined;
	}
	return undefined;
}

/**
 * After a turn: sends a notice when the context reached a band higher than the last one noticed. It never starts a
 * turn; during a run it joins the context at the end of the turn, before the next request.
 */
export function noticeContextUsage(
	api: Pick<ExtensionAPI, "sendMessage">,
	ctx: Pick<ExtensionContext, "model" | "getContextUsage">,
	messages: readonly Pick<MessageRef, "message">[],
	thinking?: CompactionThinking,
	compactTool = false,
): void {
	const model = ctx.model;
	const tokens = ctx.getContextUsage()?.tokens;
	if (!model || model.contextWindow <= 0 || typeof tokens !== "number") return;
	const limit = autoCompactAt(model, thinking);
	const band = noticeBand(tokens, limit);
	if (band === undefined) return;
	const last = lastNoticedBand(messages);
	if (last !== undefined && last >= band) return;
	try {
		void api.sendMessage(
			{
				customType: CONTEXT_NOTICE_TYPE,
				content: contextNoticeText(tokens, limit, model.contextWindow, compactTool && band >= COMPACT_HINT_BAND),
				display: false,
				details: { band, tokens, limit },
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		if (!isStaleSessionError(error)) throw error;
	}
}
