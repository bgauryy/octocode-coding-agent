import { createAnthropic } from "@ai-sdk/anthropic";
import type { Model } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import {
	assertRequestAuth,
	federationToken,
	getAnthropicFederation,
	originalCredentialFetch,
} from "../anthropic-messages/federation.ts";
import { getProviderCapabilities } from "../../utils/provider-capabilities.ts";
import { getAnthropicCompat } from "../anthropic-messages/compat.ts";
import { resolveCacheAffinityId } from "../../utils/cache-policy.ts";

export function anthropicSdkModel(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
	fetch: typeof globalThis.fetch,
) {
	const federation = getAnthropicFederation(model, options.apiKey, options.headers, options.env);
	if (!federation) assertRequestAuth(model.provider, options.apiKey, { ...model.headers, ...options.headers });
	const bearer = getProviderCapabilities(model.provider).anthropicBearerAuth;
	const base = new URL(model.baseUrl);
	const path = base.pathname.replace(/\/+$/, "");
	base.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
	const query = new URLSearchParams(base.search);
	base.search = "";
	const session = resolveCacheAffinityId(options);
	const compat = getAnthropicCompat(model);
	return createAnthropic({
		baseURL: base.href.replace(/\/$/, ""),
		...(federation
			? { authToken: federationToken(model, federation, originalCredentialFetch(options.fetch ?? globalThis.fetch)) }
			: bearer && options.apiKey
				? { authToken: options.apiKey }
				: { apiKey: options.apiKey ?? "" }),
		fetch: (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			for (const [key, value] of query) url.searchParams.set(key, value);
			const headers = new Headers(init?.headers);
			if (!options.apiKey && !federation) headers.delete("x-api-key");
			for (const [name, value] of Object.entries(options.headers ?? {}))
				if (name.toLowerCase() === "anthropic-beta") {
					if (value === null) headers.delete(name);
					else headers.set(name, value);
				}
			if (session && compat.sendSessionAffinityHeaders)
				headers.set(compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity", session);
			return fetch(url.href, { ...init, headers });
		},
	})(model.id);
}
