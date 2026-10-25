import {
	isJsonRpcId,
	isObject,
	type JsonRpcId,
	type JsonRpcResponse,
	McpAbortError,
	McpError,
	McpTimeoutError,
} from "../protocol/jsonrpc.ts";
import type { ProgressNotification } from "../protocol/types.ts";
import type { McpClientOptions, McpRequestOptions, PendingRequest } from "./types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Progress renews a request's idle timeout; this bounds its total time, so a server reporting forever still ends. */
const DEFAULT_MAX_TOTAL_TIMEOUT_MS = 30 * 60_000;

/** What the pending-request table needs from its client. */
interface PendingRequestsHost {
	/** Tell the server a request was cancelled; called after the request settled locally. */
	sendCancelled(id: JsonRpcId, reason: string | undefined): void;
	emitError(error: unknown): void;
}

/** Outgoing requests awaiting a response, with their timeouts, abort listeners and progress tokens. */
export class PendingRequests {
	private readonly host: PendingRequestsHost;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly progressRequests = new Map<JsonRpcId, JsonRpcId>();

	constructor(host: PendingRequestsHost) {
		this.host = host;
	}

	/**
	 * Track request `id` until it settles; `send` dispatches it with a signal aborted once it settles.
	 * Request options override the client's timeout `defaults`.
	 */
	start(
		id: JsonRpcId,
		method: string,
		options: McpRequestOptions,
		progressToken: JsonRpcId | undefined,
		defaults: Pick<McpClientOptions, "requestTimeoutMs" | "maxTotalTimeoutMs">,
		send: (signal: AbortSignal) => Promise<void>,
	): Promise<unknown> {
		const total = options.maxTotalTimeoutMs ?? defaults.maxTotalTimeoutMs ?? DEFAULT_MAX_TOTAL_TIMEOUT_MS;
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve,
				reject,
				timeoutMs: options.timeoutMs ?? defaults.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
				maxTotalTimeoutMs: total,
				deadline: Number.isFinite(total) && total > 0 ? Date.now() + total : Number.POSITIVE_INFINITY,
				timer: undefined,
				signal: options.signal,
				// The spec forbids cancelling `initialize`.
				onAbort: () =>
					this.cancel(id, new McpAbortError(), method !== "initialize", String(options.signal?.reason ?? "Aborted")),
				sendController: new AbortController(),
				cancellable: method !== "initialize",
				onProgress: options.onProgress,
				progressToken,
			};
			this.pending.set(id, entry);
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.armTimeout(id, entry);
			send(entry.sendController.signal).catch((error) => this.cancel(id, error, false));
		});
	}

	/** Settle the request a response answers; false when no request has that id. */
	settle(message: JsonRpcResponse): boolean {
		const entry = this.pending.get(message.id);
		if (!entry) return false;
		this.remove(message.id, entry);
		if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
		else entry.resolve(message.result);
		return true;
	}

	/** A `notifications/progress` renews the matching request's idle timeout and reaches its `onProgress`. */
	progress(params: unknown): void {
		if (!isObject(params) || !isJsonRpcId(params.progressToken) || typeof params.progress !== "number") return;
		const requestId = this.progressRequests.get(params.progressToken);
		const entry = requestId === undefined ? undefined : this.pending.get(requestId);
		if (requestId === undefined || !entry) return;
		this.armTimeout(requestId, entry);
		try {
			entry.onProgress?.(params as unknown as ProgressNotification);
		} catch (error) {
			this.host.emitError(error);
		}
	}

	/** Reject every in-flight request. */
	rejectAll(error: unknown): void {
		for (const [id, entry] of this.pending) {
			this.remove(id, entry);
			entry.reject(error);
		}
	}

	/** Arms whichever ends first: the idle timeout (renewed by progress) or the request's total deadline. */
	private armTimeout(id: JsonRpcId, entry: PendingRequest): void {
		if (entry.timer) clearTimeout(entry.timer);
		const idle = Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : Number.POSITIVE_INFINITY;
		const remaining = entry.deadline - Date.now();
		const delay = Math.min(idle, remaining);
		if (!Number.isFinite(delay)) return;
		const total = remaining <= idle;
		entry.timer = setTimeout(
			() => {
				const error = new McpTimeoutError(total ? entry.maxTotalTimeoutMs : entry.timeoutMs);
				this.cancel(id, error, entry.cancellable, "Request timed out");
			},
			Math.max(0, delay),
		);
	}

	private cancel(id: JsonRpcId, error: unknown, notifyServer: boolean, reason?: string): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.remove(id, entry);
		entry.reject(error);
		if (notifyServer) this.host.sendCancelled(id, reason);
	}

	private remove(id: JsonRpcId, entry: PendingRequest): void {
		this.pending.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.progressToken !== undefined) this.progressRequests.delete(entry.progressToken);
		entry.signal?.removeEventListener("abort", entry.onAbort);
		entry.sendController.abort();
	}
}
