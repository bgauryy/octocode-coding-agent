/**
 * Loopback OAuth redirect handler shared by the browser sign-in flows.
 *
 * NOTE: This module uses node:http. It is only reachable through the lazily
 * loaded OAuth flow modules, never from browser-facing entry points.
 */

import { createServer, type ServerResponse } from "node:http";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { ProviderAuthInteraction } from "../types.ts";

interface OAuthCallbackServerOptions<T> {
	/** Provider name used on the browser page, for example `OpenAI`. */
	providerName: string;
	/** Address to listen on. */
	host: string;
	/** Port to listen on; `0` picks a free port. */
	port: number;
	path: string;
	/** Host in `redirectUri` when it differs from `host`, for example `localhost`. */
	redirectHost?: string;
	/** Expected `state` parameter. Omit when the provider does not send one. */
	state?: string;
	/**
	 * Finishes the sign-in with the received code before the browser page is sent, so the page can
	 * show exchange failures. Pass `async (code) => code` to exchange the code later.
	 */
	complete: (code: string, callbackUrl: URL) => Promise<T>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface OAuthCallbackServer<T> {
	redirectUri: string;
	/**
	 * Resolves with the result of `complete`, or `undefined` after `cancel()`. Rejects when the provider
	 * redirects with an error, `complete` fails, the signal aborts, or the timeout elapses.
	 */
	wait(): Promise<T | undefined>;
	/** Stop waiting for the browser unless a callback is already being completed. */
	cancel(): void;
	close(): void;
}

/** Address the loopback callback server listens on: `OCTOCODE_OAUTH_CALLBACK_HOST`, else `127.0.0.1`. */
export function getOAuthCallbackHost(): string {
	return getProviderEnvValue("OCTOCODE_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

function sendPage(response: ServerResponse, status: number, html: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(html);
}

export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");

	let resolveWait: (value: T | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// A cancelled or closed wait may never be observed.
	waitPromise.catch(() => undefined);

	let claimed = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => finish({ error: new Error("Login cancelled") });
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if ("error" in result) rejectWait(result.error);
		else resolveWait(result.value);
	};

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method !== "GET" || url.pathname !== options.path) {
				sendPage(response, 404, oauthErrorHtml("Callback route not found."));
				return;
			}
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				sendPage(response, 400, oauthErrorHtml("State mismatch."));
				return;
			}
			if (claimed || settled) {
				sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const description = url.searchParams.get("error_description") ?? error;
				sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, description));
				finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
				return;
			}
			claimed = true;
			try {
				const value = await options.complete(code, url);
				sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
				finish({ value });
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
				finish({ error: failure });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}

	server.on("error", (error) => finish({ error }));
	signal?.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	}
	const redirectHost = options.redirectHost ?? options.host;
	return {
		redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
		wait: () => waitPromise,
		cancel: () => {
			if (!claimed) finish({ value: undefined });
		},
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			server.close();
			server.closeAllConnections();
		},
	};
}

/**
 * Wait for the browser callback, or for the user to paste the code or redirect URL when the browser
 * cannot reach the loopback server (for example over SSH). Without a callback server only the manual
 * prompt is used.
 */
export async function waitForCallbackOrManualInput<T>(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallbackServer<T> | undefined,
	prompt: { message: string; placeholder: string },
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	const manualAbort = new AbortController();
	// Assigned from the prompt's rejection handler, which control-flow analysis cannot see.
	let manualError = undefined as Error | undefined;
	const manual = raceWithAbortSignal(
		interaction.prompt({
			type: "manual_code",
			...prompt,
			signal: AbortSignal.any([manualAbort.signal, interaction.signal]),
		}),
		interaction.signal,
	)
		.then((input) => {
			callback?.cancel();
			return input;
		})
		.catch((error: unknown) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			callback?.cancel();
			return undefined;
		});
	try {
		const value = await callback?.wait();
		if (manualError) throw manualError;
		if (value !== undefined) return { type: "callback", value };
		const input = await manual;
		// The prompt's rejection handler ran during the await above; control-flow analysis still sees `undefined`.
		const failed = manualError as Error | undefined;
		if (failed) throw failed;
		return { type: "manual", input: input ?? "" };
	} finally {
		manualAbort.abort();
	}
}

/** A code pasted by hand: the full redirect URL, `code#state`, a `code=…&state=…` query, or the bare code. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}
