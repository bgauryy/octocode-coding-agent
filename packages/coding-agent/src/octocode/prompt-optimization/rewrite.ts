import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { captureSpend } from "../../core/spend-capture.ts";
import { INTERACTIVE_RETRY } from "../shared/side-retry.ts";
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
 * One small-tier call (the session's model when no cheaper one resolves) that rewrites `prompt` for a coding agent. The
 * user waits on it, so a rate limit or transient failure gets a short retry. Never rejects: a failed, cancelled or empty
 * call gives `{ error }`. What an answered call spent goes to `/usage` (`captureSpend`), whether or not the rewrite is used.
 */
export async function rewritePrompt(
	ctx: FeatureContext,
	prompt: string,
	signal: AbortSignal,
	complete?: CompleteSmall,
): Promise<{ text: string; model: string } | { error: string }> {
	const quoted = prompt.replaceAll("</request>", "");
	const cwd = ctx.cwd;
	const reply = await callSmallModel(ctx, {
		text: `${REWRITE_PROMPT}\n\n<request>\n${quoted}\n</request>`,
		signal,
		maxTokens: Math.min(MAX_REPLY_TOKENS, Math.max(MIN_REPLY_TOKENS, prompt.length)),
		fallbackToSession: true,
		retry: INTERACTIVE_RETRY,
		...(complete ? { complete } : {}),
	});
	if ("error" in reply) return reply;
	captureSpend({ cwd, kind: "prompt_rewrite", provider: reply.provider, model: reply.modelId, usage: reply.usage });
	const text = rewriteFromReply(reply.text);
	return text ? { text, model: reply.model } : { error: `${reply.model} returned an empty rewrite` };
}
