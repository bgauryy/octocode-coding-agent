import {
	type CallOptions,
	DEFAULT_MAX_RESPONSE_BYTES,
	DEFAULT_TIMEOUT_MS,
	type OperationClientConfig,
} from "./config.ts";
import { OperationError, redactSecrets } from "./errors.ts";

export type BodyKind = "json" | "text" | "bytes";

export interface RequestSpec {
	operation: string;
	method: "GET" | "POST" | "DELETE";
	path: string;
	query?: Record<string, string | number | undefined>;
	json?: unknown;
	form?: FormData;
	headers?: Record<string, string>;
}

const ERROR_BODY_LIMIT = 4096;

function joinUrl(config: OperationClientConfig, spec: RequestSpec): string {
	let url: URL;
	try {
		url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/${spec.path.replace(/^\/+/, "")}`);
	} catch {
		throw new OperationError("invalid_input", spec.operation, "baseUrl is not a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new OperationError("invalid_input", spec.operation, "baseUrl must use http or https");
	}
	for (const [k, v] of Object.entries(spec.query ?? {})) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}
	return url.toString();
}

/** Configured values that must never survive in an error message, including custom auth headers. */
export function operationSecrets(config: OperationClientConfig): (string | undefined)[] {
	return [config.apiKey, ...Object.values(config.headers ?? {})];
}

export function authHeaders(config: OperationClientConfig): Record<string, string> {
	const headers: Record<string, string> = { ...config.headers };
	if (config.apiKey) {
		const name = config.auth?.header ?? "Authorization";
		const scheme = config.auth?.scheme ?? "Bearer";
		headers[name] = scheme ? `${scheme} ${config.apiKey}` : config.apiKey;
	}
	return headers;
}

async function readBounded(response: Response, limit: number, operation: string): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => undefined);
		throw new OperationError("response_too_large", operation, `response exceeds ${limit} bytes`);
	}
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				throw new OperationError("response_too_large", operation, `response exceeds ${limit} bytes`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function errorMessage(bytes: Uint8Array, secrets: (string | undefined)[]): string {
	const text = new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_LIMIT));
	try {
		const parsed: unknown = JSON.parse(text);
		const err = (parsed as { error?: unknown } | null)?.error;
		const message =
			typeof err === "string"
				? err
				: ((err as { message?: unknown } | null)?.message ?? (parsed as { message?: unknown } | null)?.message);
		if (typeof message === "string") return redactSecrets(message.slice(0, 500), secrets);
	} catch {
		// not JSON: fall through to raw text
	}
	return redactSecrets(text.slice(0, 500), secrets);
}

export type ParsedBody<K extends BodyKind> = K extends "json" ? unknown : K extends "text" ? string : Uint8Array;

/** One bounded HTTP exchange with timeout, cancellation and secret-safe errors. */
export async function perform<K extends BodyKind>(
	config: OperationClientConfig,
	spec: RequestSpec,
	kind: K,
	options: CallOptions = {},
): Promise<{ body: ParsedBody<K>; headers: Headers }> {
	const { operation } = spec;
	const secrets = operationSecrets(config);
	const url = joinUrl(config, spec);
	if (options.signal?.aborted) throw new OperationError("aborted", operation, "aborted before start");
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const limit = options.maxResponseBytes ?? config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const headers = { ...authHeaders(config), ...spec.headers };
	if (spec.json !== undefined) headers["Content-Type"] = "application/json";
	try {
		let response: Response;
		let bytes: Uint8Array;
		try {
			response = await fetchImpl(url, {
				method: spec.method,
				headers,
				body: spec.form ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json)),
				signal: controller.signal,
			});
			bytes = await readBounded(response, response.ok ? limit : ERROR_BODY_LIMIT, operation).catch((error) => {
				if (!response.ok && error instanceof OperationError && error.kind === "response_too_large") {
					return new Uint8Array(0);
				}
				throw error;
			});
		} catch (error) {
			if (error instanceof OperationError) throw error;
			if (timedOut) throw new OperationError("timeout", operation, `timed out after ${timeoutMs} ms`);
			if (options.signal?.aborted || controller.signal.aborted)
				throw new OperationError("aborted", operation, "aborted");
			const detail = error instanceof Error ? error.message : String(error);
			throw new OperationError("network", operation, redactSecrets(detail, secrets));
		}
		if (!response.ok) {
			throw new OperationError(
				"http",
				operation,
				`HTTP ${response.status}: ${errorMessage(bytes, secrets)}`,
				response.status,
			);
		}
		if (kind === "bytes") return { body: bytes as ParsedBody<K>, headers: response.headers };
		const text = new TextDecoder("utf-8", { fatal: true });
		let decoded: string;
		try {
			decoded = text.decode(bytes);
		} catch {
			throw new OperationError("malformed_response", operation, "response is not valid UTF-8");
		}
		if (kind === "text") return { body: decoded as ParsedBody<K>, headers: response.headers };
		try {
			return { body: JSON.parse(decoded) as ParsedBody<K>, headers: response.headers };
		} catch {
			throw new OperationError("malformed_response", operation, "response is not valid JSON");
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

// -- response shape guards --------------------------------------------------

export function asRecord(value: unknown, operation: string, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new OperationError("malformed_response", operation, `${what} must be an object`);
	}
	return value as Record<string, unknown>;
}

export function asArray(value: unknown, operation: string, what: string): unknown[] {
	if (!Array.isArray(value)) throw new OperationError("malformed_response", operation, `${what} must be an array`);
	return value;
}

export function asString(value: unknown, operation: string, what: string): string {
	if (typeof value !== "string") throw new OperationError("malformed_response", operation, `${what} must be a string`);
	return value;
}

export function asNumber(value: unknown, operation: string, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new OperationError("malformed_response", operation, `${what} must be a finite number`);
	}
	return value;
}

export function optString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function optNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function requireNonEmpty(value: string, operation: string, what: string): void {
	if (value.trim() === "") throw new OperationError("invalid_input", operation, `${what} must not be empty`);
}

export function requireId(value: string, operation: string): string {
	if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value))
		throw new OperationError("invalid_input", operation, "id has invalid characters");
	return encodeURIComponent(value);
}
