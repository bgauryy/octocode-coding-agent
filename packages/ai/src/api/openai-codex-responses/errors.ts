import { formatThrownValue } from "../../utils/diagnostics.ts";
import { PREVIOUS_RESPONSE_NOT_FOUND_CODE, WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE } from "./types.ts";

export class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export class ProviderStreamEventCallbackError extends Error {
	constructor(cause: unknown) {
		super(formatThrownValue(cause));
		this.name = "ProviderStreamEventCallbackError";
		this.cause = cause;
	}
}

export function isCodexNonTransportError(error: unknown): boolean {
	return (
		error instanceof CodexApiError ||
		error instanceof CodexProtocolError ||
		error instanceof ProviderStreamEventCallbackError
	);
}

export function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

export function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}
