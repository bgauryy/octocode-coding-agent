import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";
import type { StreamOptions } from "../../types.ts";
import { RESPONSES_TOOL_CALL_PROVIDERS } from "../openai-responses-shared/messages.ts";

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
export const DEFAULT_MAX_RETRIES = 0;
export const BASE_DELAY_MS = 1000;
export const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
export const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
export const CODEX_TOOL_CALL_PROVIDERS = RESPONSES_TOOL_CALL_PROVIDERS;
export const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
export const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
export const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

export const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}

export type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}
