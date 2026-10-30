import { StreamableHTTPClientTransport, SdkHttpError, type JSONRPCMessage } from "@modelcontextprotocol/client";
import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	McpAbortError,
	type JsonRpcId,
	type JsonRpcMessage,
} from "../protocol/jsonrpc.ts";
import { SdkTransport } from "./sdk.ts";
import { sdkHttpPolicy } from "./sdk-http.ts";
import { McpAuthRequiredError } from "./streamable-http/http.ts";
import type { McpTransportSendOptions } from "./transport.ts";

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxRetries?: number };
}

/** Official MCP Streamable HTTP transport with host credential and body-size policy. */
export class StreamableHttpTransport extends SdkTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private readonly http: StreamableHTTPClientTransport;
	private readonly policy: ReturnType<typeof sdkHttpPolicy>;
	private readonly pending = new Map<JsonRpcId, () => void>();
	private closing?: Promise<void>;

	constructor(options: StreamableHttpTransportOptions) {
		const url = new URL(options.url);
		const policy = sdkHttpPolicy({ ...options, url });
		const http = new StreamableHTTPClientTransport(url, {
			fetch: policy.fetch,
			authProvider: policy.authProvider,
			requestInit: { headers: options.headers, redirect: "manual" },
			reconnectionOptions: {
				initialReconnectionDelay: options.reconnect?.initialDelayMs ?? 1_000,
				maxReconnectionDelay: options.reconnect?.maxDelayMs ?? 30_000,
				maxRetries: options.reconnect?.maxRetries ?? 5,
				reconnectionDelayGrowFactor: 2,
			},
		});
		super(http);
		this.url = url;
		this.http = http;
		this.policy = policy;
		this.options = Object.freeze({ ...options });
		http.onmessage = (message) => {
			if (isJsonRpcResponse(message)) this.settle(message.id);
			this.emitMessage(message as JsonRpcMessage);
		};
	}
	get sessionId(): string | undefined {
		return this.http.sessionId;
	}
	async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
		if (options?.signal?.aborted) throw new McpAbortError(undefined, options.signal.reason);
		const id = isJsonRpcRequest(message) ? message.id : undefined;
		const clear = () => {
			if (id !== undefined) this.settle(id);
		};
		if (id !== undefined) {
			this.settle(id);
			this.pending.set(id, () => options?.signal?.removeEventListener("abort", clear));
			options?.signal?.addEventListener("abort", clear, { once: true });
		}
		try {
			await this.http.send(message as JSONRPCMessage, {
				requestSignal: options?.signal,
				onRequestStreamEnd: () => {
					if (id === undefined || !this.settle(id)) return;
					this.emitMessage({
						jsonrpc: "2.0",
						id,
						error: {
							code: JSON_RPC_ERROR_CODES.internalError,
							message: "MCP response stream failed: stream ended without a response",
						},
					});
				},
			});
		} catch (error) {
			clear();
			if (error instanceof SdkHttpError && error.status === 401)
				throw new McpAuthRequiredError(new Response(null, { status: 401 }));
			throw error;
		}
	}
	private settle(id: JsonRpcId): boolean {
		const cleanup = this.pending.get(id);
		if (!cleanup) return false;
		this.pending.delete(id);
		cleanup();
		return true;
	}
	close(): Promise<void> {
		return (this.closing ??= this.closeSession());
	}
	private async closeSession(): Promise<void> {
		this.policy.beginClose();
		try {
			if (this.http.sessionId) await this.http.terminateSession();
		} catch {
			// Session deletion is best effort; the SDK reports the error and local cleanup must still finish.
		} finally {
			for (const cleanup of this.pending.values()) cleanup();
			this.pending.clear();
			await super.close();
		}
	}
}
