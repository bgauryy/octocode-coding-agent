export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Connection settings shared by every operation client. */
export interface OperationClientConfig {
	/** Service root, e.g. `https://api.openai.com/v1`. Must be http(s). */
	baseUrl: string;
	apiKey?: string;
	/** Header carrying the key. Default `Authorization` with scheme `Bearer`; use `scheme: ""` for a raw key header. */
	auth?: { header?: string; scheme?: string };
	headers?: Record<string, string>;
	/** Injectable fetch; defaults to the global one. */
	fetch?: typeof fetch;
	/** Per-call timeout. Default 60 s. */
	timeoutMs?: number;
	/** Cap on any response body in bytes. Default 32 MiB. */
	maxResponseBytes?: number;
}

/** Per-call overrides. */
export interface CallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
}
