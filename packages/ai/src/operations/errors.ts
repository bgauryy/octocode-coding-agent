/** Failure categories for model operations. */
export type OperationErrorKind =
	| "invalid_input"
	| "http"
	| "malformed_response"
	| "response_too_large"
	| "timeout"
	| "aborted"
	| "network"
	| "transport"
	| "job_failed";

export class OperationError extends Error {
	readonly kind: OperationErrorKind;
	readonly operation: string;
	readonly status?: number;

	constructor(kind: OperationErrorKind, operation: string, message: string, status?: number) {
		super(`${operation}: ${message}`);
		this.name = "OperationError";
		this.kind = kind;
		this.operation = operation;
		this.status = status;
	}
}

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_LIKE = /\b(?:sk|key|tok)[-_][A-Za-z0-9_-]{8,}/g;

/** Strips the configured secret and common credential shapes from text destined for errors. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
	}
	return out.replace(BEARER, "Bearer [redacted]").replace(KEY_LIKE, "[redacted]");
}
