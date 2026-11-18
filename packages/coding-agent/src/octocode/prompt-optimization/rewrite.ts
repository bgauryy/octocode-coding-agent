import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { type CompleteSmall, callSmallModel } from "../subagents/small-call.ts";

/** The rewrite request (`native/prompts/workflows/optimize-prompt.md`). */
const REWRITE_PROMPT = renderPrompt("workflows/optimize-prompt.md");

const MIN_REPLY_TOKENS = 512;
const MAX_REPLY_TOKENS = 4096;

/** The model's reply without the `<request>` tags it may wrap around the rewrite. */
function rewriteFromReply(reply: string): string {
	const text = reply.trim();
	const wrapped = /^<request>\s*([\s\S]*?)\s*<\/request>$/.exec(text);
	return (wrapped ? wrapped[1] : text).trim();
}

/**
 * One small-tier call (the session's model when no cheaper one resolves) that rewrites `prompt` for a coding agent.
 * Never rejects: a failed, cancelled or empty call gives `{ error }`.
 */
export async function rewritePrompt(
	ctx: FeatureContext,
	prompt: string,
	signal: AbortSignal,
	complete?: CompleteSmall,
): Promise<{ text: string; model: string } | { error: string }> {
	const quoted = prompt.replaceAll("</request>", "");
	const reply = await callSmallModel(ctx, {
		text: `${REWRITE_PROMPT}\n\n<request>\n${quoted}\n</request>`,
		signal,
		maxTokens: Math.min(MAX_REPLY_TOKENS, Math.max(MIN_REPLY_TOKENS, prompt.length)),
		fallbackToSession: true,
		...(complete ? { complete } : {}),
	});
	if ("error" in reply) return reply;
	const text = rewriteFromReply(reply.text);
	return text ? { text, model: reply.model } : { error: `${reply.model} returned an empty rewrite` };
}
