import type { ApiKeyVerdict } from "./types.ts";

const VERIFY_TIMEOUT_MS = 8_000;

/**
 * Asks a provider's free endpoint (a model list or token-info call) whether it accepts a credential. 401 and 403 are
 * a refusal; any other answer or a network failure means the key could not be checked, which is not a refusal. The
 * caller's own abort is rethrown.
 */
export async function verifyByRequest(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<ApiKeyVerdict> {
	try {
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]),
		});
		if (response.status === 401 || response.status === 403) return "rejected";
		return response.ok ? "valid" : "unreachable";
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof Error) return "unreachable";
		throw error;
	}
}
