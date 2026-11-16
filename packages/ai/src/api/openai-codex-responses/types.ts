import type { StreamOptions } from "../../types.ts";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_CODEX_ORIGINATOR = "Octocode";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: "auto" | "default" | "flex" | "priority" | "fast" | "ultrafast";
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}
