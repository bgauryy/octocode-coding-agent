import { decodeJwt } from "jose";
import type { ProviderHeaders } from "../../types.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import {
	DEFAULT_CODEX_BASE_URL,
	DEFAULT_CODEX_ORIGINATOR,
	JWT_CLAIM_PATH,
	type OpenAICodexResponsesOptions,
} from "./types.ts";
export { applyServiceTierPricing } from "../openai-responses-shared/service-tier.ts";

type ServiceTier = OpenAICodexResponsesOptions["serviceTier"];
export function resolveCodexServiceTier(
	responseServiceTier: ServiceTier,
	requestServiceTier: ServiceTier,
): ServiceTier {
	if (
		responseServiceTier === "default" &&
		(requestServiceTier === "flex" || requestServiceTier === "priority" || requestServiceTier === "fast")
	)
		return requestServiceTier;
	return responseServiceTier ?? requestServiceTier;
}

export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function extractAccountId(token: string): string {
	try {
		const auth = decodeJwt(token)[JWT_CLAIM_PATH];
		const accountId =
			auth && typeof auth === "object" && "chatgpt_account_id" in auth ? auth.chatgpt_account_id : undefined;
		if (typeof accountId !== "string" || !accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

export function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = new Headers({ originator: DEFAULT_CODEX_ORIGINATOR, "User-Agent": getUserAgent() });
	for (const [key, value] of Object.entries(initHeaders ?? {})) headers.set(key, value);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}
