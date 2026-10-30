import type { AuthProvider as SdkAuthProvider } from "@modelcontextprotocol/client";
import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import { DEFAULT_MAX_MESSAGE_BYTES } from "./transport.ts";
import { boundedBody } from "./http-body.ts";
import {
	discard,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
	readText,
	rejectRedirect,
	describeHttpFailure,
	MAX_ERROR_BODY_BYTES,
} from "./streamable-http/http.ts";

/** Host security and resource policy around SDK-owned HTTP/session/SSE handling. */
export function sdkHttpPolicy(options: {
	url: URL;
	fetch?: McpFetch;
	authProvider?: AuthProvider;
	maxMessageBytes?: number;
	openGetStream?: boolean;
}) {
	const fetch = options.fetch ?? globalThis.fetch;
	const rejectedTokens = new WeakMap<Response, string | undefined>();
	let lastToken: string | undefined;
	let closing = false;
	const authProvider: SdkAuthProvider | undefined = options.authProvider && {
		token: async () => {
			if (!closing) lastToken = await options.authProvider!.token();
			return lastToken;
		},
		onUnauthorized: async ({ response, serverUrl }) => {
			try {
				if (closing || !options.authProvider?.onUnauthorized) throw new McpAuthRequiredError(response);
				await options.authProvider.onUnauthorized({
					response,
					serverUrl,
					// OAuth endpoints may use another origin. Do not inherit credentialed MCP request headers.
					fetch,
					token: rejectedTokens.get(response),
				});
			} finally {
				await discard(response);
			}
		},
	};
	const guardedFetch = async (input: string | URL, init?: RequestInit, scopeRetried = false): Promise<Response> => {
		init?.signal?.throwIfAborted();
		if (init?.method === "GET" && options.openGetStream === false && !new Headers(init.headers).has("last-event-id"))
			return new Response(null, { status: 405 });
		const signal =
			init?.method === "DELETE"
				? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(2_000)])
				: init?.signal;
		let response = await fetchWithAbort(fetch, input, { ...init, signal, redirect: "manual", credentials: "omit" });
		await rejectRedirect(response, options.url);
		if (response.status >= 300 && response.status < 400) {
			await discard(response);
			throw new McpHttpError(response.status, "MCP HTTP redirect refused");
		}
		if (signal?.aborted) {
			await discard(response);
			signal.throwIfAborted();
		}
		const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "");
		if (response.body) {
			const events = response.ok && response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
			// Host-read failures below truncate at 8 KiB. Responses the SDK drains need their own bound.
			const limit = response.ok
				? (options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
				: (response.status === 401 && authProvider) || response.status === 405
					? MAX_ERROR_BODY_BYTES
					: Infinity;
			response = new Response(boundedBody(response.body, limit, !!events, signal), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}
		rejectedTokens.set(response, token);
		if (response.status === 403 && /insufficient_scope/i.test(response.headers.get("www-authenticate") ?? "")) {
			try {
				if (closing || scopeRetried || !options.authProvider?.onUnauthorized) throw new McpAuthRequiredError(response);
				await options.authProvider.onUnauthorized({ response, serverUrl: options.url, fetch, token });
				signal?.throwIfAborted();
				const replacement = await options.authProvider.token();
				signal?.throwIfAborted();
				if (!replacement || replacement === token) throw new McpAuthRequiredError(response);
				const headers = new Headers(init?.headers);
				headers.set("authorization", `Bearer ${replacement}`);
				lastToken = replacement;
				// Scope recovery is host policy. Retry at most once; ordinary 401 recovery remains SDK-owned.
				return await guardedFetch(input, { ...init, headers, signal }, true);
			} finally {
				await discard(response);
			}
		}
		if (response.status === 401 && !authProvider) {
			const body = await readText(response, MAX_ERROR_BODY_BYTES, true);
			throw new McpAuthRequiredError(response, body);
		}
		if (response.status === 404 && new Headers(init?.headers).has("mcp-session-id")) {
			const body = await readText(response, MAX_ERROR_BODY_BYTES, true);
			throw new McpSessionExpiredError(body);
		}
		if (!response.ok && response.status !== 401 && !(init?.method === "GET" && response.status === 405)) {
			const body = await readText(response, MAX_ERROR_BODY_BYTES, true);
			throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
		}
		if (response.status === 202 && init?.method === "POST" && typeof init.body === "string") {
			const message = JSON.parse(init.body) as { id?: unknown; method?: unknown };
			if (message.id !== undefined && message.method !== undefined) {
				await discard(response);
				throw new Error("MCP server accepted a request without a response");
			}
		}
		return response;
	};
	return {
		fetch: guardedFetch,
		authProvider,
		beginClose: () => {
			closing = true;
		},
	};
}

/** Injected fetch implementations must not hold shutdown or cancelled requests open. */
async function fetchWithAbort(fetch: McpFetch, input: string | URL, init: RequestInit): Promise<Response> {
	const signal = init.signal;
	signal?.throwIfAborted();
	if (!signal) return fetch(input, init);
	let abort = () => {};
	try {
		return await Promise.race([
			fetch(input, init).then((response) => {
				if (signal.aborted) {
					void discard(response);
					signal.throwIfAborted();
				}
				return response;
			}),
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
