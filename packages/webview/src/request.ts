const REQUEST_TIMEOUT_MS = 15_000;

/** Every view reads a refused sign-in the same way: the link is missing, used up or expired. */
export const SIGN_IN_MESSAGE = "Not signed in: this link is missing or has expired. Run /web again to open a new one.";

/** A refused request: the host's text, plus its short fixed `code` when it sent one (never key or file text). */
export class RequestError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(message: string, status: number, code: string | undefined) {
		super(message);
		this.name = "RequestError";
		this.status = status;
		this.code = code;
	}
}

/** Bound the full response, including its body, without retrying a mutation whose outcome may be unknown. */
export function requestJson<T = unknown>(
	url: string,
	options: RequestInit = {},
	fallback = "Request failed",
): Promise<T> {
	return request(url, options, fallback, async (response) => (await response.json()) as T);
}

/** A file download under the same bound, sign-in message and error text as a JSON read. */
export function requestBlob(url: string, options: RequestInit = {}, fallback = "Request failed"): Promise<Blob> {
	return request(url, options, fallback, (response) => response.blob());
}

async function request<T>(
	url: string,
	options: RequestInit,
	fallback: string,
	read: (response: Response) => Promise<T>,
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
		if (response.status === 401) throw new Error(SIGN_IN_MESSAGE);
		if (!response.ok) throw await failure(response, fallback);
		return await read(response);
	} catch (error) {
		if (controller.signal.aborted) throw controller.signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

/** The host's `{ error, code }`; a proxy or HTML error page that is not JSON gets the caller's text instead. */
async function failure(response: Response, fallback: string): Promise<RequestError> {
	const result: unknown = await response.json().catch(() => undefined);
	const body = result && typeof result === "object" ? (result as { error?: unknown; code?: unknown }) : {};
	return new RequestError(
		typeof body.error === "string" ? body.error : fallback,
		response.status,
		typeof body.code === "string" ? body.code : undefined,
	);
}
