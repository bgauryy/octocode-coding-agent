import type { StreamOptions } from "../../types.ts";

export type MistralReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}
