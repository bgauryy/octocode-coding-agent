import { createMistral } from "@ai-sdk/mistral";
import type { Model, StreamOptions } from "../../types.ts";
import { resolveCacheRetention } from "../../utils/cache-policy.ts";

export function mistralSdkModel(
	model: Model<"mistral-conversations">,
	options: StreamOptions,
	fetch: typeof globalThis.fetch,
) {
	if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = new URL(model.baseUrl);
	base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1`;
	const query = new URLSearchParams(base.search);
	base.search = "";
	return createMistral({
		apiKey: options.apiKey,
		baseURL: base.href.replace(/\/$/, ""),
		fetch: (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			for (const [key, value] of query) url.searchParams.append(key, value);
			const headers = new Headers(init?.headers);
			const overridden = [model.headers, options.headers].some((source) =>
				Object.keys(source ?? {}).some((key) => key.toLowerCase() === "x-affinity"),
			);
			if (!overridden && options.sessionId && resolveCacheRetention(options.cacheRetention, options.env) !== "none")
				headers.set("x-affinity", options.promptCacheKey ?? options.sessionId);
			headers.set("accept", "text/event-stream");
			for (const source of [model.headers, options.headers])
				for (const [key, value] of Object.entries(source ?? {})) {
					if (value === null) headers.delete(key);
					else headers.set(key, value);
				}
			return fetch(url.href, { ...init, headers });
		},
	})(model.id);
}
