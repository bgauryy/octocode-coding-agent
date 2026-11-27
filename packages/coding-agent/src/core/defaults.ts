import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";

/**
 * A session's level when neither the call, the session nor settings name one: high, because the main session coordinates
 * and judges. Subagents never reach it; their route always names a level (`subagents/model.ts` `subagentThinking`).
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
