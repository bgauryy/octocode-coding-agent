import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, isRecoverableLength } from "@octocodeai/octocode-ai/compat";

/** Continuations one run may request after replies cut off at the output limit; more means the reply cannot fit. */
export const MAX_LENGTH_CONTINUATIONS = 2;

const LENGTH_CONTINUATION_TEXT =
	"Your previous reply reached the output token limit and was cut off. Continue exactly where it stopped, " +
	"without repeating what you already wrote. If the remaining work is long, split it across shorter replies or tool calls.";

/**
 * The message that asks the model to resume a reply cut off at the output limit, or undefined when the run should
 * stop: the reply ended normally, carried tool calls (the loop already fails those and lets the model resend them),
 * stopped below the model's output limit (a full context, which compact-and-retry recovers after the run), or the run
 * used its continuations.
 */
export function lengthContinuationMessage(
	message: AssistantMessage,
	continuationsUsed: number,
	desiredMaxOutput: number,
): AgentMessage | undefined {
	if (message.stopReason !== "length") return undefined;
	// An unknown limit (a virtual model routes to another) cannot tell a full output from a full context.
	if (desiredMaxOutput <= 0 || isRecoverableLength(message, desiredMaxOutput)) return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	if (continuationsUsed >= MAX_LENGTH_CONTINUATIONS) return undefined;
	return { role: "user", content: [{ type: "text", text: LENGTH_CONTINUATION_TEXT }], timestamp: Date.now() };
}

/** Consecutive turns whose tool calls were failed for being cut off at the output limit before the run ends. */
export const MAX_TRUNCATED_TOOL_TURNS = 3;

export const TRUNCATED_TOOL_TURNS_MESSAGE =
	`Run stopped: ${MAX_TRUNCATED_TOOL_TURNS} replies in a row were cut off at the output limit in the middle of tool calls, ` +
	"so none of those calls ran. Ask for smaller steps, or raise the model's output limit.";

/** The consecutive count after this turn: a reply with tool calls cut at the output limit adds one, any other turn resets it. */
export function nextTruncatedToolTurns(message: AssistantMessage, previous: number): number {
	const cutToolCalls = message.stopReason === "length" && message.content.some((block) => block.type === "toolCall");
	return cutToolCalls ? previous + 1 : 0;
}
