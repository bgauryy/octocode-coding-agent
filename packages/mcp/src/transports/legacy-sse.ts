import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	type JsonRpcMessage,
	McpAbortError,
	McpConnectionClosedError,
	parseJsonRpcMessage,
} from "../protocol/jsonrpc.ts";
import {
	contentType,
	describeHttpFailure,
	discard,
	MAX_ERROR_BODY_BYTES,
	McpAuthRequiredError,
	McpHttpError,
	needsAuthorization,
	readText,
	rejectRedirect,
} from "./streamable-http/http.ts";
import { consumeSseStream } from "./streamable-http/sse.ts";
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	type McpTransport,
	type McpTransportSendOptions,
	TransportEvents,
} from "./transport.ts";

const DEFAULT_ENDPOINT_TIMEOUT_MS = 10_000;

export interface LegacySseTransportOptions {
	/** The older MCP SSE GET endpoint, not the POST endpoint supplied by its endpoint event. */
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	authProvider?: AuthProvider;
	maxMessageBytes?: number;
	/** Deadline for the server's endpoint event. Default: 10 seconds. */
	endpointTimeoutMs?: number;
}

/** MCP 2024-11 HTTP+SSE: a long-lived GET stream advertises one same-origin POST endpoint. */
export class LegacySseTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<LegacySseTransportOptions>;
	private readonly fetch: McpFetch;
	private readonly controller = new AbortController();
	private started = false;
	private closed = false;
	private endpoint?: URL;
	private ready?: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

	constructor(options: LegacySseTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		if (!/^https?:$/.test(this.url.protocol) || this.url.username || this.url.password || this.url.hash)
			throw new Error("Legacy MCP SSE URL must be HTTP(S), without credentials or fragment");
		const fetch = options.fetch ?? globalThis.fetch;
		this.fetch = (input, init) => fetch(input, init);
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP legacy SSE transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = this.options.endpointTimeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS;
			const timer = setTimeout(() => this.fail(new Error("MCP legacy SSE endpoint event timed out")), timeout);
			this.ready = { resolve, reject, timer };
		});
		void this.openStream();
		return ready;
	}

	async send(message: JsonRpcMessage, { signal }: McpTransportSendOptions = {}): Promise<void> {
		const endpoint = this.endpoint;
		if (!endpoint || this.closed) throw new McpConnectionClosedError();
		if (signal?.aborted) throw new McpAbortError();
		const body = JSON.stringify(message);
		if (Buffer.byteLength(body) > (this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES))
			throw new Error("MCP legacy SSE outgoing message exceeds byte limit");
		const response = await this.authorizedFetch(
			endpoint,
			"POST",
			{
				accept: "application/json",
				"content-type": "application/json",
			},
			body,
			signal,
		);
		try {
			await this.checkResponse(response);
		} finally {
			await discard(response);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		this.rejectReady(new McpConnectionClosedError());
		this.emitClose();
	}

	private resolveReady(): void {
		const ready = this.ready;
		if (!ready) return;
		this.ready = undefined;
		clearTimeout(ready.timer);
		ready.resolve();
	}

	private rejectReady(error: Error): void {
		const ready = this.ready;
		if (!ready) return;
		this.ready = undefined;
		clearTimeout(ready.timer);
		ready.reject(error);
	}

	private fail(error: unknown): void {
		if (this.closed) return;
		const normalized = error instanceof Error ? error : new Error("MCP legacy SSE stream failed");
		this.rejectReady(normalized);
		this.emitError(normalized);
		void this.close();
	}

	private async openStream(): Promise<void> {
		try {
			const response = await this.authorizedFetch(this.url, "GET", { accept: "text/event-stream" });
			if (this.closed) {
				await discard(response);
				return;
			}
			await this.checkResponse(response);
			if (contentType(response) !== "text/event-stream" || !response.body) {
				await discard(response);
				throw new Error("MCP legacy SSE server did not provide an event stream");
			}
			await consumeSseStream(response.body, {
				signal: this.controller.signal,
				maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
				onEvent: (event) => {
					if (this.closed) return;
					if (!event.data.trim()) return;
					if (event.event === "endpoint") {
						if (this.endpoint) return this.fail(new Error("MCP legacy SSE endpoint changed during the session"));
						try {
							this.endpoint = this.validateEndpoint(event.data);
						} catch (error) {
							this.fail(error);
							return;
						}
						this.resolveReady();
					} else if (!event.event || event.event === "message") {
						try {
							this.emitMessage(parseJsonRpcMessage(JSON.parse(event.data)));
						} catch (error) {
							this.fail(error);
						}
					}
				},
			});
			if (!this.closed) this.fail(new Error("MCP legacy SSE stream ended"));
		} catch (error) {
			this.fail(error);
		}
	}

	private validateEndpoint(value: string): URL {
		const endpoint = new URL(value.trim(), this.url);
		if (
			endpoint.origin !== this.url.origin ||
			!/^https?:$/.test(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.hash
		)
			throw new Error("MCP legacy SSE POST endpoint must be same-origin HTTP(S), without credentials or fragment");
		return endpoint;
	}

	private async authorizedFetch(
		url: URL,
		method: "GET" | "POST",
		extra: Record<string, string>,
		body?: string,
		signal?: AbortSignal,
	): Promise<Response> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		for (let attempt = 0; ; attempt++) {
			const token = await this.options.authProvider?.token();
			if (this.closed || this.controller.signal.aborted) throw new McpConnectionClosedError();
			if (signal?.aborted) throw new McpAbortError();
			const headers = new Headers(this.options.headers);
			for (const [key, value] of Object.entries(extra)) headers.set(key, value);
			if (token) headers.set("authorization", `Bearer ${token}`);
			const response = await this.fetch(url, {
				method,
				headers,
				body,
				redirect: "manual",
				credentials: "omit",
				signal: signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal,
			});
			if (this.closed || signal?.aborted) {
				await discard(response);
				throw signal?.aborted ? new McpAbortError() : new McpConnectionClosedError();
			}
			await rejectRedirect(response, url);
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			try {
				await onUnauthorized({ response, serverUrl: url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
			// Only the single auth challenge may replay this POST, and cancellation prevents that replay.
			if (this.closed || signal?.aborted) throw signal?.aborted ? new McpAbortError() : new McpConnectionClosedError();
		}
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		const text = await readText(response, MAX_ERROR_BODY_BYTES, true).catch(() => "");
		if (response.status === 401) throw new McpAuthRequiredError(response, text);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, text), text);
	}
}
