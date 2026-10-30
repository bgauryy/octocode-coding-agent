import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { type JsonRpcMessage, McpAbortError } from "../protocol/jsonrpc.ts";
import { TransportEvents, type McpTransport, type McpTransportSendOptions } from "./transport.ts";

/** Adapts the SDK's single callbacks to the host's subscription contract. */
export abstract class SdkTransport extends TransportEvents implements McpTransport {
	protected readonly sdk: Transport;
	protected closed = false;

	constructor(sdk: Transport) {
		super();
		this.sdk = sdk;
		sdk.onmessage = (message) => this.emitMessage(message as JsonRpcMessage);
		sdk.onerror = (error) => this.emitError(error);
		sdk.onclose = () => this.emitClose();
	}
	start(): Promise<void> {
		return this.sdk.start();
	}
	setProtocolVersion(version: string): void {
		this.sdk.setProtocolVersion?.(version);
	}
	async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
		if (options?.signal?.aborted) throw new McpAbortError(undefined, options.signal.reason);
		await this.sdk.send(message as JSONRPCMessage, { requestSignal: options?.signal });
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.sdk.close();
		} finally {
			this.emitClose();
		}
	}
}
