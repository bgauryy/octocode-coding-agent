import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	McpAbortError,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	toError,
} from "../protocol/jsonrpc.ts";
import {
	contentType,
	describeHttpFailure,
	discard,
	isRetryable,
	MAX_ERROR_BODY_BYTES,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
	needsAuthorization,
	readText,
	rejectRedirect,
} from "./streamable-http/http.ts";
import { consumeSseStream, type StreamCursor } from "./streamable-http/sse.ts";
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	type McpTransport,
	type McpTransportSendOptions,
	TransportEvents,
} from "./transport.ts";

export { McpAuthRequiredError, McpHttpError, McpSessionExpiredError } from "./streamable-http/http.ts";
export { type ConsumeSseOptions, consumeSseStream, type SseEvent } from "./streamable-http/sse.ts";

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;

export interface StreamableHttpReconnectOptions {
	/** Delay before the first reconnection attempt, unless the server sent a `retry` field. Default: 1000. */
	initialDelayMs?: number;
	/** Upper bound for the exponential backoff. Default: 30000. */
	maxDelayMs?: number;
	/** Consecutive failed attempts before giving up on a stream. Default: 5. */
	maxRetries?: number;
}

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	/** Open the server-to-client GET stream after initialization. Default: true. */
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	/** Reconnection of dropped SSE streams (the GET stream, and response streams that carry event IDs). */
	reconnect?: StreamableHttpReconnectOptions;
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: string | undefined;
	private getStreamStarted = false;
	/** Access token of the latest request, which `close()` reuses instead of asking the auth provider. */
	private lastToken: string | undefined;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		// Call fetch without a receiver. `this.fetch(...)` and `context.fetch(...)` would pass the transport or
		// the auth context as `this`, which Cloudflare Workers reject for the platform fetch ("Illegal invocation").
		this.fetch = (input, init) => fetch(input, init);
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	async send(message: JsonRpcMessage, { signal }: McpTransportSendOptions = {}): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const response = await this.authorizedFetch(
			"POST",
			{
				headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
				body: JSON.stringify(message),
			},
			signal,
		);
		await this.checkResponse(response);
		this.captureSession(response);

		if (!isJsonRpcRequest(message)) {
			// Notifications and responses are acknowledged with 202 and carry no reply; ignore any body.
			await discard(response);
			// The server-to-client stream may only open once the session is initialized.
			if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
			return;
		}
		if (response.status === 202 || response.status === 204) {
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		const type = contentType(response);
		if (type === "application/json") {
			const body: unknown = JSON.parse(
				await readText(response, this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
			);
			for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
			return;
		}
		if (type === "text/event-stream" && response.body) {
			void this.consumeResponseStream(response.body, message.id, signal);
			return;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.started && this.sessionIdValue) {
			// Best effort: the session expires on the server anyway. The auth provider may refresh tokens
			// over the network, so it is not asked here and closing never waits for a refresh.
			try {
				const response = await this.fetch(this.url, {
					method: "DELETE",
					headers: this.buildHeaders({}, this.lastToken),
					redirect: "manual",
					credentials: "omit",
					signal: AbortSignal.timeout(1_000),
				});
				await rejectRedirect(response, this.url);
				await discard(response);
			} catch {}
		}
		this.emitClose();
	}

	/**
	 * Fetch with auth headers. A 401 (or a 403 asking for more scope) is handed to the auth provider
	 * once, and the request is retried with whatever credentials it left behind.
	 *
	 * `signal` stops dispatch: getting a token or the authorization recovery can take a while, and a
	 * request its sender gave up on in the meantime must not reach the server. Once dispatched, it also aborts
	 * this request's own fetch (and the response body being read), so a request that timed out or was cancelled does
	 * not hold its connection until the server answers. It does not abort the shared recovery, which other
	 * requests may wait for.
	 */
	private async authorizedFetch(
		method: "GET" | "POST",
		init: { headers: Record<string, string>; body?: string },
		signal?: AbortSignal,
	): Promise<Response> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		for (let attempt = 0; ; attempt++) {
			const { headers, token } = await this.headers(init.headers);
			if (signal?.aborted) throw new McpAbortError();
			const response = await this.fetch(this.url, {
				method,
				headers,
				body: init.body,
				redirect: "manual",
				credentials: "omit",
				signal: signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal,
			});
			await rejectRedirect(response, this.url);
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			try {
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
		}
	}

	private async headers(extra: Record<string, string> = {}): Promise<{ headers: Headers; token?: string }> {
		const token = await this.options.authProvider?.token();
		this.lastToken = token;
		return { headers: this.buildHeaders(extra, token), ...(token ? { token } : {}) };
	}

	private buildHeaders(extra: Record<string, string>, token: string | undefined): Headers {
		const headers = new Headers(this.options.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		if (this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}

	private captureSession(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		const body = await readText(response, MAX_ERROR_BODY_BYTES, true).catch(() => "");
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	private async consumeSse(
		stream: ReadableStream<Uint8Array>,
		cursor: StreamCursor,
		onMessage?: (message: JsonRpcMessage) => void,
		signal?: AbortSignal,
	): Promise<void> {
		await consumeSseStream(stream, {
			signal,
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			onId: (id) => {
				cursor.lastEventId = id;
			},
			onRetry: (delayMs) => {
				cursor.retryMs = delayMs;
			},
			onEvent: (event) => {
				cursor.received = true;
				// Events without data prime resumption; other event types are not JSON-RPC.
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				let message: JsonRpcMessage;
				try {
					message = parseJsonRpcMessage(JSON.parse(event.data));
				} catch (error) {
					this.emitError(error);
					return;
				}
				onMessage?.(message);
				this.emitMessage(message);
			},
		});
	}

	/**
	 * Read the SSE stream answering one request. When the stream ends or breaks before the response
	 * arrives and the server assigned event IDs, resume it with GET and `Last-Event-ID`, as the
	 * server may close response streams at will. Otherwise only this request fails.
	 */
	private async consumeResponseStream(
		body: ReadableStream<Uint8Array>,
		requestId: JsonRpcId,
		signal?: AbortSignal,
	): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		let answered = false;
		const onMessage = (message: JsonRpcMessage) => {
			if (isJsonRpcResponse(message) && message.id === requestId) answered = true;
		};
		let stream: ReadableStream<Uint8Array> | undefined = body;
		let failure: unknown;
		for (let attempt = 0; ;) {
			if (stream) {
				try {
					await this.consumeSse(stream, cursor, onMessage, signal);
					failure = undefined;
				} catch (error) {
					failure = error;
				}
			}
			// A settled request (answered, timed out or cancelled) needs neither this stream nor a resumption.
			if (answered || this.closed || signal?.aborted) return;
			if (failure !== undefined && !isRetryable(failure)) break;
			if (cursor.lastEventId === undefined || attempt >= this.maxRetries()) break;
			if (cursor.received) attempt = 0;
			cursor.received = false;
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
			try {
				stream = await this.openSseStream(cursor.lastEventId);
			} catch (error) {
				failure = error;
				if (!isRetryable(error)) break;
				stream = undefined;
			}
		}
		if (this.closed) return;
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	private startGetStream(): void {
		if (this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
		this.getStreamStarted = true;
		void this.runGetStream();
	}

	/** Keep the server-to-client stream open, reconnecting with backoff when it drops. */
	private async runGetStream(): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		for (let attempt = 0; !this.closed;) {
			try {
				const stream = await this.openSseStream(cursor.lastEventId);
				// The server does not offer a GET stream.
				if (!stream) return;
				const openedAt = Date.now();
				await this.consumeSse(stream, cursor);
				// A stream that stayed up for a while counts as healthy, even if it was idle.
				if (cursor.received || Date.now() - openedAt > this.maxDelay()) attempt = 0;
			} catch (error) {
				if (this.closed) return;
				if (!isRetryable(error)) {
					this.emitError(error);
					return;
				}
			}
			cursor.received = false;
			if (attempt >= this.maxRetries()) {
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
		}
	}

	/** Open a GET SSE stream. Resolves to undefined when the server answers 405 (no GET stream). */
	private async openSseStream(lastEventId: string | undefined): Promise<ReadableStream<Uint8Array> | undefined> {
		const response = await this.authorizedFetch("GET", {
			headers: {
				accept: "text/event-stream",
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		});
		if (response.status === 405) {
			await discard(response);
			return undefined;
		}
		await this.checkResponse(response);
		this.captureSession(response);
		const type = contentType(response);
		if (type !== "text/event-stream" || !response.body) {
			await discard(response);
			throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
		}
		return response.body;
	}

	private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
		if (serverDelayMs !== undefined) return serverDelayMs;
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		return Math.min(initial * 2 ** attempt, this.maxDelay());
	}

	private maxDelay(): number {
		return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
	}

	private maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}

	/** Resolves false when the transport closed while waiting. */
	private sleep(ms: number): Promise<boolean> {
		const signal = this.controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			// A reconnect wait alone does not keep the process alive.
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
