const REQUEST_TIMEOUT_MS = 15_000;

/** Bound the full response, including its body, without retrying a mutation whose outcome may be unknown. */
export async function requestJson<T = unknown>(
	url: string,
	options: RequestInit = {},
	fallback = "Request failed",
): Promise<T> {
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("Request timed out. Check the current state before retrying.")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const result: unknown = await response.json();
		if (!response.ok) {
			const error = result && typeof result === "object" && "error" in result ? result.error : undefined;
			throw new Error(typeof error === "string" ? error : fallback);
		}
		return result as T;
	} catch (error) {
		if (controller.signal.aborted) throw controller.signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}
