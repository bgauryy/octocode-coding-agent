import {
	isJsonRpcId,
	isObject,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcRequest,
	McpError,
	toError,
} from "../protocol/jsonrpc.ts";
import type { McpTransport } from "../transports/transport.ts";
import type { RequestHandler } from "./types.ts";

/** Requests the server sends to the client: their handlers and the ones being served. */
export class IncomingRequests {
	private readonly handlers = new Map<string, RequestHandler>();
	private readonly active = new Map<JsonRpcId, AbortController>();
	private readonly emitError: (error: unknown) => void;

	constructor(emitError: (error: unknown) => void) {
		this.emitError = emitError;
	}

	setHandler(method: string, handler: RequestHandler): () => void {
		this.handlers.set(method, handler);
		return () => {
			if (this.handlers.get(method) === handler) this.handlers.delete(method);
		};
	}

	/** Answer one server request over `transport`, with a result or a JSON-RPC error. */
	async handle(message: JsonRpcRequest, transport: McpTransport): Promise<void> {
		const handler = this.handlers.get(message.method);
		if (!handler) {
			await transport
				.send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
				})
				.catch((error) => this.emitError(error));
			return;
		}
		const controller = new AbortController();
		this.active.set(message.id, controller);
		try {
			const result = await handler(message.params, { signal: controller.signal });
			await transport.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
		} catch (error) {
			const responseError =
				error instanceof McpError
					? { code: error.code, message: error.message, data: error.data }
					: { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message };
			await transport
				.send({ jsonrpc: "2.0", id: message.id, error: responseError })
				.catch((sendError) => this.emitError(sendError));
		} finally {
			this.active.delete(message.id);
		}
	}

	/** A `notifications/cancelled` aborts the server request it names. */
	cancel(params: unknown): void {
		if (isObject(params) && isJsonRpcId(params.requestId)) this.active.get(params.requestId)?.abort(params.reason);
	}

	/** Abort every server request being served. */
	abortAll(error: Error): void {
		for (const controller of this.active.values()) controller.abort(error);
		this.active.clear();
	}
}
