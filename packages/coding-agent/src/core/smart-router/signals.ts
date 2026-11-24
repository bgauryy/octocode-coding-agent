import { type Api, type AssistantMessage, isContextOverflow, type Message, type Model } from "@octocodeai/octocode-ai";
import { estimateTokens } from "../compaction/tokens.ts";
import { matchesPattern } from "./filters.ts";
import type { CapabilityTier, FailureKind, ModelPattern } from "./types.ts";

/** Effort ladder, lowest first. */
export const EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const HARD_WORDS =
	/\b(refactor|architect\w*|design|root cause|race condition|deadlock|security|vulnerab\w*|migrat\w*|optimi[sz]\w*|concurren\w*|performance|rewrite)\b/i;
const TRIVIAL = /^\s*(thanks?|thank you|ok(ay)?|yes|no|continue|go on|proceed|lgtm|typo|rename|format)\b/i;
const TRANSIENT =
	/\b(overloaded|rate.?limit|too many requests|429|5\d\d|timeout|timed out|unavailable|econn\w*|network|fetch failed|capacity|try again)\b/i;
const ACCESS =
	/\b(401|403|unauthori[sz]ed|forbidden|invalid.{0,12}(api.?key|credential)|permission|not.{0,12}access|does not have access|not found|no such model)\b/i;

export interface Complexity {
	level: 0 | 1 | 2 | 3;
	/** Labels only; never message content. */
	signals: string[];
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** Index of the last user message, or -1. */
function lastUserIndex(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
	return -1;
}

/** Deterministic task difficulty from the conversation shape, with no model call. */
export function assessComplexity(messages: readonly Message[], failures: number): Complexity {
	let level = 1;
	const signals: string[] = [];
	const bump = (delta: number, signal: string) => {
		level += delta;
		signals.push(signal);
	};
	const userIndex = lastUserIndex(messages);
	if (userIndex < 0) return { level: 1, signals: ["no-user-message"] };
	const text = textOf(messages[userIndex]);
	if (text.length > 4000) bump(1, "long-prompt");
	if (HARD_WORDS.test(text)) bump(1, "hard-keywords");
	if (text.length < 200 && TRIVIAL.test(text)) bump(-1, "trivial-request");
	let toolErrors = 0;
	let toolResults = 0;
	for (const message of messages.slice(userIndex + 1)) {
		if (message.role !== "toolResult") continue;
		toolResults++;
		if (message.isError) toolErrors++;
	}
	if (toolErrors >= 2) bump(1, "tool-errors");
	if (toolResults >= 8) bump(1, "long-tool-loop");
	if (failures >= 2) bump(1, "repeated-failures");
	return { level: Math.max(0, Math.min(3, level)) as Complexity["level"], signals };
}

export function requiredTier(level: Complexity["level"]): CapabilityTier {
	return level >= 3 ? 3 : level === 2 ? 2 : 1;
}

/** Effort ladder index a task of this difficulty starts at. */
export function baseEffortIndex(level: Complexity["level"]): number {
	return [0, 2, 3, 4][level];
}

/** Estimated prompt tokens of the conversation. */
export function estimateInputTokens(messages: readonly Message[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateTokens(message);
	return tokens;
}

/** A new image waits for an answer: it comes after the latest assistant message. */
export function hasPendingImage(messages: readonly Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return false;
		if (message.role === "system" || typeof message.content === "string") continue;
		if (message.content.some((block) => block.type === "image")) return true;
	}
	return false;
}

export function classifyFailure(message: AssistantMessage, contextWindow?: number): FailureKind {
	if (message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "length") return "quality";
	const text = message.errorMessage ?? "";
	if (isContextOverflow(message, contextWindow)) return "context";
	if (ACCESS.test(text)) return "access";
	if (TRANSIENT.test(text)) return "transient";
	// An unrecognized error is treated as the model's: switching beats repeating it.
	return "transient";
}

/** Tier from catalog metadata, used when `tiers` names no match: reasoning, a large window and a high price each add one. */
function derivedTier(model: Model<Api>): CapabilityTier {
	// Without a window the catalog says nothing about the model: assume a general model, not a weak one.
	if (!(model.contextWindow > 0)) return 2;
	let score = 0;
	if (model.reasoning) score++;
	if (model.contextWindow >= 200_000) score++;
	if (model.cost.output >= 10) score++;
	return (1 + Math.min(1, score) + (score >= 3 ? 1 : 0)) as CapabilityTier;
}

export function tierOf(
	model: Model<Api>,
	key: string,
	tiers: Readonly<Record<ModelPattern, CapabilityTier>> | undefined,
): CapabilityTier {
	if (tiers) for (const [pattern, tier] of Object.entries(tiers)) if (matchesPattern(pattern, key)) return tier;
	return derivedTier(model);
}
