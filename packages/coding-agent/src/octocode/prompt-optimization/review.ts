import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ExtensionContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";
import { hintText, interruptKey } from "../../theme/theme-tui-helpers.ts";
import { rewritePrompt } from "./rewrite.ts";
import { deadline } from "@octocodeai/octocode-common/deadline";

/** How long the helper may take before the user is offered the original. */
const REWRITE_TIMEOUT_MS = 30_000;
const STATUS_KEY = "optimize";

const SEND_REWRITE = "Send the optimized prompt";
const EDIT_REWRITE = "Edit the optimized prompt";
const SEND_ORIGINAL = "Send my original prompt";
const CANCEL = "Cancel";

/** What the helper call came to: the rewrite, or why there is none (`Esc` skipped it, it timed out, or it failed). */
async function requestRewrite(
	ctx: ExtensionContext,
	prompt: string,
): Promise<{ text: string; model: string } | { error: string }> {
	const skip = new AbortController();
	const limit = deadline(REWRITE_TIMEOUT_MS);
	const timeout = limit.signal;
	ctx.ui.setStatus(
		STATUS_KEY,
		`✦ Optimizing prompt…${interruptKey() ? ` · ${hintText([[interruptKey(), "skip"]])}` : ""}`,
		"accent",
	);
	const stopListening = ctx.ui.onTerminalInput((data) => {
		if (data !== "\x1b") return undefined;
		skip.abort();
		return { consume: true };
	});
	try {
		const result = await rewritePrompt(ctx, prompt, AbortSignal.any([skip.signal, timeout]));
		if (!("error" in result)) return result;
		if (skip.signal.aborted) return { error: "it was skipped" };
		if (timeout.aborted) return { error: `the helper did not answer within ${REWRITE_TIMEOUT_MS / 1000} s` };
		return result;
	} finally {
		limit.clear();
		stopListening();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

/**
 * The text to send for a submitted `prompt`, after the user has seen the helper's rewrite and chosen: the rewrite, their
 * edit of it, or the original. A helper that fails or is skipped is reported and the original offered. Undefined when the
 * user dismisses a dialog or cancels: nothing is sent, and the caller keeps the prompt.
 */
export async function reviewPrompt(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
	const result = await requestRewrite(ctx, prompt);
	if ("error" in result) {
		const choice = await ctx.ui.select(
			sanitizeTerminalText(`Prompt optimization failed: ${result.error}. Send your original prompt?`),
			[SEND_ORIGINAL, CANCEL],
		);
		return choice === SEND_ORIGINAL ? prompt : undefined;
	}
	if (result.text === prompt.trim()) {
		notify(ctx.ui, "Prompt optimization: the prompt is already clear; sending it as written.");
		return prompt;
	}
	const title = sanitizeTerminalText(`Optimized prompt (${result.model}):\n\n${result.text}`);
	for (;;) {
		const choice = await ctx.ui.select(title, [SEND_REWRITE, EDIT_REWRITE, SEND_ORIGINAL]);
		if (choice === SEND_REWRITE) return result.text;
		if (choice === SEND_ORIGINAL) return prompt;
		if (choice !== EDIT_REWRITE) return undefined;
		const edited = await ctx.ui.editor("Edit the optimized prompt", result.text);
		if (edited?.trim()) return edited;
	}
}
