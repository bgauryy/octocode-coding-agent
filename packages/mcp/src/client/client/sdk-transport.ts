import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/client";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isObject,
	type JsonRpcId,
	type JsonRpcMessage,
} from "../protocol/jsonrpc.ts";
import type { McpTransport } from "../transports/transport.ts";

/** Retains transport listeners and aborts legacy HTTP dispatch after its SDK request settles. */
export class SdkTransportAdapter implements Transport {
	onmessage?: Transport["onmessage"];
	onerror?: Transport["onerror"];
	onclose?: Transport["onclose"];
	private readonly pending = new Map<JsonRpcId, AbortController>();
	private readonly disposers: (() => void)[] = [];
	private closing: Promise<void> | undefined;
	private readonly transport: McpTransport;

	constructor(transport: McpTransport, observe: (method: string, params: unknown) => void) {
		this.transport = transport;
		this.disposers.push(
			transport.onMessage((message) => {
				if (isJsonRpcResponse(message)) this.settle(message.id);
				if (isJsonRpcNotification(message)) observe(message.method, message.params);
				this.onmessage?.(message as JSONRPCMessage);
			}),
			transport.onError((error) => this.onerror?.(error)),
			transport.onClose(() => {
				this.abortPending();
				try {
					this.onclose?.();
				} finally {
					for (const dispose of this.disposers.splice(0)) dispose();
				}
			}),
		);
	}
	start(): Promise<void> {
		return this.transport.start();
	}
	setProtocolVersion(version: string): void {
		this.transport.setProtocolVersion?.(version);
	}
	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		if (isJsonRpcNotification(message) && message.method === "notifications/cancelled" && isObject(message.params)) {
			const id = message.params.requestId;
			if (typeof id === "string" || typeof id === "number") this.settle(id);
		}
		if (!isJsonRpcRequest(message))
			return this.transport.send(message as JsonRpcMessage, { signal: options?.requestSignal });
		const controller = new AbortController();
		this.pending.set(message.id, controller);
		const signal = options?.requestSignal
			? AbortSignal.any([options.requestSignal, controller.signal])
			: controller.signal;
		try {
			await this.transport.send(message, { signal });
		} catch (error) {
			this.settle(message.id);
			throw error;
		}
	}
	close(): Promise<void> {
		return (this.closing ??= Promise.resolve().then(() => this.closeTransport()));
	}
	private async closeTransport(): Promise<void> {
		this.abortPending();
		try {
			await this.transport.close();
		} finally {
			for (const dispose of this.disposers.splice(0)) dispose();
		}
	}
	private settle(id: JsonRpcId): void {
		this.pending.get(id)?.abort();
		this.pending.delete(id);
	}
	private abortPending(): void {
		for (const controller of this.pending.values()) controller.abort();
		this.pending.clear();
	}
}
