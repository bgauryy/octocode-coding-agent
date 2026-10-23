import type * as NodeZlib from "node:zlib";
import { formatThrownValue } from "../../utils/diagnostics.ts";
import { CodexProtocolError } from "./errors.ts";
import { REQUEST_COMPRESSION_ZSTD_LEVEL } from "./types.ts";

// ============================================================================
// Request Compression
// ============================================================================

type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function loadNodeZlib(): typeof NodeZlib | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib") ?? null;
}

// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
export function compressRequestBodyZstd(bodyJson: string): Uint8Array<ArrayBuffer> | null {
	const zlib = loadNodeZlib();
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		return null;
	}
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		// A copy owns a plain ArrayBuffer, which fetch accepts as a body under every lib.
		return new Uint8Array(compressed);
	} catch {
		return null;
	}
}

// ============================================================================
// SSE Parsing
// ============================================================================

export async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// Preserve compatibility with servers that omit the final blank line.
			if (done) buffer += "\n\n";
			for (;;) {
				const end = buffer.search(/[\r\n]/);
				// Wait for the next chunk before deciding whether a trailing CR begins CRLF.
				if (end < 0 || (!done && end === buffer.length - 1 && buffer[end] === "\r")) break;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
				if (line === "") {
					const data = dataLines.join("\n").trim();
					dataLines = [];
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				} else if (line === "data" || line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^ /, ""));
				}
			}

			if (done) break;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// Error Handling
// ============================================================================

export async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000)) : undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, friendlyMessage };
}
