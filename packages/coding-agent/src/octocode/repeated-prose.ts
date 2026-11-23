import type { FeatureSetup } from "../core/features/index.ts";
import { say } from "./shared/commands.ts";

/** A single model stream can loop without ever reaching the tool guard. Compare short, complete sentences within a
 * text block. Read each delta once and retain at most two sentences, regardless of the length of the response. */
export function registerRepeatedProseGuard(api: FeatureSetup): void {
	const reason = "Loop guard stopped repeated assistant text.";
	const maxSentence = 256;
	let block: number | undefined;
	let pending = "";
	let previous = "";
	let count = 0;
	let stopped = false;
	api.bus.on("message_start", () => {
		block = undefined;
		stopped = false;
	});
	api.bus.on("message_end", ({ message }) => {
		if (stopped && message.role === "assistant")
			return { message: { ...message, stopReason: "aborted", errorMessage: reason } };
		return undefined;
	});
	api.bus.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (stopped || update.type !== "text_delta") return;
		if (update.contentIndex !== block) {
			block = update.contentIndex;
			pending = "";
			previous = "";
			count = 0;
		}
		for (const [, fragment, ending] of update.delta.matchAll(/([^.!?。！？\n]+)|([.!?。！？\n])/gu)) {
			if (fragment) {
				if (pending.length <= maxSentence) pending += fragment.slice(0, maxSentence + 1 - pending.length);
				continue;
			}
			const sentence = pending.trim() + ending;
			const prose = ending !== "\n" && pending.length <= maxSentence && /\p{L}.*\s+\p{L}/u.test(sentence);
			pending = "";
			count = prose && sentence === previous ? count + 1 : 1;
			previous = prose ? sentence : "";
			if (count < 16 || count * sentence.length < 512) continue;
			stopped = true;
			say(ctx, reason, "error");
			ctx.failRun(reason);
			ctx.abort("internal");
			return;
		}
	});
}
