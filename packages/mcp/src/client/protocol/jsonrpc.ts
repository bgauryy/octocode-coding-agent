export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;

export class McpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

export class McpConnectionClosedError extends Error {
	constructor(message = "MCP connection closed") {
		super(message);
		this.name = "McpConnectionClosedError";
	}
}

export class McpTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`MCP request timed out after ${timeoutMs}ms`);
		this.name = "McpTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/** A request its caller's signal cancelled; `cause` is the signal's reason when it had one. */
export class McpAbortError extends Error {
	constructor(message = "MCP request aborted", reason?: unknown) {
		super(message, reason === undefined ? undefined : { cause: reason });
		this.name = "AbortError";
	}
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
	return isJSONRPCRequest(message);
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
	return isJSONRPCNotification(message);
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	return isJSONRPCResponse(message) && isJsonRpcId(message.id);
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	try {
		return parseJSONRPCMessage(value) as JsonRpcMessage;
	} catch {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
	}
}
import {
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResponse,
	parseJSONRPCMessage,
} from "@modelcontextprotocol/client";
