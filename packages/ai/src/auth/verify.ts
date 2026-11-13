import type { ApiKeyVerdict } from "./types.ts";

const VERIFY_TIMEOUT_MS = 8_000;

/**
 * Asks a provider's free endpoint whether it accepts a credential. A 401 refuses it; a 403 can instead mean a valid
 * key lacks permission to list models, so it cannot establish whether model requests are allowed. Other failures
 * leave the key unchecked. The caller's own abort is rethrown.
 */
export async function verifyByRequest(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<ApiKeyVerdict> {
	try {
		const response = await fetch(url, {
			headers,
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]),
		});
		// Only status is needed. Release the body without making cleanup failures change the auth verdict.
		void response.body?.cancel().catch(() => {});
		if (response.status === 401) return "rejected";
		if (response.status === 403) return "forbidden";
		return response.ok ? "valid" : "unreachable";
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof Error) return "unreachable";
		throw error;
	}
}
