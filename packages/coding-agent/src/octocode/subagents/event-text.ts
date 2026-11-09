import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { thoughtGist } from "../render/thought.ts";
import { contentText } from "../shared/util.ts";
import { toolHint } from "../../utils/tool-hint.ts";

export function assistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = contentText(message.content).trim();
	return text || undefined;
}

/** A reply's reasoning as trail lines: each thinking block's gist, then its narration when tool calls follow (a final answer is the report). */
export function replySteps(message: Record<string, unknown>): string[] {
	if (!Array.isArray(message.content)) return [];
	const steps: string[] = [];
	for (const part of message.content) {
		if (!isRecord(part)) continue;
		const gist =
			part.type === "thinking" && typeof part.thinking === "string" ? thoughtGist(part.thinking, true) : undefined;
		if (gist) steps.push(`✻ ${gist}`);
	}
	const narration = message.stopReason === "toolUse" ? assistantText(message) : undefined;
	if (narration) steps.push(`› ${redactSecrets(narration.replace(/\s+/g, " "))}`);
	return steps;
}

/** A call's own deadline in ms: its `timeout` argument (seconds), when it declares one. */
export function declaredTimeout(args: unknown): number | undefined {
	const seconds = isRecord(args) ? args.timeout : undefined;
	return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

export function describeToolCall(name: unknown, args: unknown): string {
	const hint = toolHint(args);
	return `→ ${String(name)}${hint ? ` ${hint}` : ""}`;
}
