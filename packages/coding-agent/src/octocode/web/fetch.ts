import { setTimeout as sleep } from "node:timers/promises";
import { APPLICATION_IMAGE_MIME_TYPES } from "@octocodeai/octocode-contracts";
import { formatBytes } from "../../utils/bytes.ts";
import { type InlineImageType, sniffImageType } from "@octocodeai/octocode-ai/utils/vision";
import {
	CrossHostRedirect,
	discardBody,
	NetworkError,
	type PublicFetchInit,
	publicFetch,
	TruncatedBodyError,
} from "../../../../common/src/web-guard.ts";
import { decodeBody } from "./charset.ts";
import {
	conditionalHeaders,
	type Freshness,
	freshnessOf,
	type PageEntry,
	pageCache,
	sharedRequests,
} from "./page-cache.ts";
import { describeHtml, RENDER_ADVICE } from "./html.ts";
import { type Deadline, deadline } from "../../../../common/src/deadline.ts";

export const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** The time limit of one request with its body, and of a whole search. */
export const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_BODY_MB = MAX_BODY_BYTES / 1024 / 1024;
/** Transient statuses a fetch retries, how often, the first backoff, and the longest Retry-After worth waiting for. */
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRIES = 2;
const RETRY_BASE_MS = 400;
const RETRY_AFTER_MAX_MS = 5_000;
/** An image the server sent: its real format (by signature) and bytes, at most `MAX_BODY_BYTES`. */
export interface FetchedImage {
	url: string;
	mimeType: InlineImageType;
	bytes: Uint8Array;
}

export interface FetchedNotice {
	kind: "notice";
	reason: "redirect" | "unsupported";
	text: string;
}

/** Page content and transport notices have distinct shapes: page text cannot impersonate a notice. */
export type Fetched = string | FetchedImage | FetchedNotice;

/** The system's locale (Node follows LC_ALL / LANG), e.g. `en-US`. */
const systemLocale = (): string => Intl.DateTimeFormat().resolvedOptions().locale;

/**
 * Accept-Language the way a browser on this machine asks: the system's language first, English as the fallback
 * (`he-IL` → `he-IL,he;q=0.9,en;q=0.8`, `en-US` → `en-US,en;q=0.9`). A user who wants pages in another language
 * starts Octocode with that LANG.
 */
export function language(locale = systemLocale()): string {
	const base = locale.split("-")[0].toLowerCase();
	const tags = [locale, ...(base !== locale ? [base] : []), ...(base !== "en" ? ["en"] : [])];
	return tags.map((tag, index) => (index === 0 ? tag : `${tag};q=${(1 - index / 10).toFixed(1)}`)).join(",");
}

const REDIRECT_NOTE = "The target is server-supplied and not verified; fetch it with web if you trust it.";
const UNREAD_NOTE = "; web cannot read it. Download it with bash (curl -o) if you need the file.";
/** Leads a page whose compressed body ended early; such a page is not cached, so the next fetch tries again. */
const CUT_NOTE = `[Incomplete: ${new TruncatedBodyError().message}; only the part that arrived is shown`;
/**
 * Content types an image is read from; SVG is not one: it is XML text, shown as its source and never rendered. The
 * application's image types, plus `image/jpg`, which is not a registered type but is what some servers send for a JPEG.
 */
const INLINE_IMAGE_HEADERS = new Set<string>([...APPLICATION_IMAGE_MIME_TYPES, "image/jpg"]);
const mediaType = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();

const unsupported = (text: string): FetchedNotice => ({ kind: "notice", reason: "unsupported", text });

/**
 * A URL as text: HTML reduced to its readable content with a note when a browser may show something else, JSON
 * pretty-printed, other text as is; or, for a PNG, JPEG, GIF or WebP, the image itself. Transient failures are retried; a
 * successful page is cached for 15 minutes (an image is not); a redirect to another host is reported instead of followed.
 * `private`: the first request may reach a private address (the user approved this URL as a `net.private` ask).
 */
export interface FetchOptions {
	private?: boolean;
	/** The addresses the caller resolved and checked for the URL's host: the first request goes to these without another lookup. */
	addresses?: string[];
}

export type PageFetcher = (url: string, signal?: AbortSignal, options?: FetchOptions) => Promise<Fetched>;

/**
 * A fetcher that owns its page cache and its fetches under way: the web tool makes one per registration, so a reload starts
 * empty, and a test makes one per case. Callers asking for the same page share a request, which is aborted once every
 * caller has stopped waiting.
 */
export function pageFetcher(): PageFetcher {
	const cache = pageCache();
	const share = sharedRequests<Fetched>();

	/** Fetches one URL, asking the server to confirm `stale` when it has validators, and caches its text. */
	async function loadUrl(url: string, signal: AbortSignal, options: FetchOptions, stale?: PageEntry): Promise<Fetched> {
		let freshness: Freshness | undefined;
		let headers: Headers | undefined;
		let text: Fetched | typeof NOT_MODIFIED;
		try {
			text = await fetchResource(url, signal, options, stale && conditionalHeaders(stale), (received) => {
				headers = received;
				freshness = freshnessOf(received);
			});
		} catch (error) {
			// The model decides whether a server-supplied target is worth fetching; it is not followed on the page's word.
			if (error instanceof CrossHostRedirect)
				return { kind: "notice", reason: "redirect", text: `${error.message}\n${REDIRECT_NOTE}` };
			throw error;
		}
		if (text === NOT_MODIFIED) {
			cache.renew(url, stale!, headers!);
			return stale!.text;
		}
		if (typeof text !== "string" || text.startsWith(CUT_NOTE)) return text;
		cache.set(url, text, freshness!);
		return text;
	}

	return async function fetchUrl(url, signal, options = {}) {
		signal?.throwIfAborted();
		const cached = cache.get(url);
		if (cached?.fresh) return cached.entry.text;
		const revalidate = cached && (cached.entry.etag || cached.entry.lastModified) ? cached.entry : undefined;
		if (cached && !revalidate) cache.delete(url);
		return share(url, (shared) => loadUrl(url, shared, options, revalidate), signal);
	};
}

/** Retry-After in milliseconds (seconds or an HTTP date); undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
	if (!header) return undefined;
	if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
	const at = Date.parse(header);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const backoff = (attempt: number) => RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_BASE_MS);

const causeOf = (error: NetworkError) => (error as { cause?: { code?: unknown; message?: unknown } }).cause;

/**
 * Advice for a cause that fails the same way on every try (so it is not retried), or undefined for one that may pass
 * later. A refused connection or an untrusted certificate is no bot block: a browser would meet the same.
 */
function lastingCause(error: NetworkError): string | undefined {
	const code = causeOf(error)?.code;
	if (typeof code !== "string") return undefined;
	if (code === "ECONNREFUSED")
		return "Nothing accepts connections at that address and port: check the URL, or start the server first";
	if (/^(?:CERT_|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_(?:GET|VERIFY))/.test(code))
		return "Its TLS certificate is not trusted here; do not work around the check: ask the user whether the site is expected to use this certificate";
	return undefined;
}

/** The network cause of a failed fetch (ECONNRESET, ENOTFOUND, a TLS error), or a timeout. */
function describeFetchError(error: unknown, url: string, tries: number): Error {
	if (
		error instanceof Error &&
		(error.name === "TimeoutError" || (error.name === "AbortError" && /timeout/i.test(error.message)))
	) {
		return new Error(`Timed out after ${TIMEOUT_MS / 1000}s fetching ${url}`);
	}
	if (!(error instanceof NetworkError)) return error instanceof Error ? error : new Error(String(error));
	const cause = causeOf(error);
	const detail = [cause?.code, cause?.message].filter((part) => typeof part === "string" && part).join(": ");
	const advice = lastingCause(error) ?? `The site may block automated requests; ${RENDER_ADVICE}`;
	return new Error(
		`Could not fetch ${url}: ${detail || error.message}${tries > 1 ? ` (tried ${tries} times)` : ""}. ${advice}.`,
	);
}

/**
 * `publicFetch`, retrying network errors and transient statuses (408/425/429/5xx) with backoff and jitter, honouring a
 * short Retry-After; a longer one is returned for the caller to report.
 */
async function fetchWithRetry(
	url: string,
	init: PublicFetchInit,
	options: FetchOptions,
	signal: AbortSignal | undefined,
	/** Each attempt's limit, so the caller clears the last once it has read the body. */
	limits: Deadline[],
): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		const limit = deadline(TIMEOUT_MS, signal);
		limits.push(limit);
		try {
			response = await publicFetch(
				url,
				{ ...init, signal: limit.signal },
				{ sameHost: true, firstHopPrivate: options.private === true, firstHopAddresses: options.addresses },
			);
		} catch (error) {
			limit.clear();
			// Only passing network failures are worth another try: not a refusal, a redirect, a timeout, the user's abort,
			// a refused connection or an untrusted certificate.
			if (signal?.aborted || !(error instanceof NetworkError) || lastingCause(error) || attempt >= RETRIES)
				throw describeFetchError(error, url, attempt + 1);
			await sleep(backoff(attempt), undefined, { signal });
			continue;
		}
		if (!RETRY_STATUSES.has(response.status) || attempt >= RETRIES) return response;
		const wait = retryAfterMs(response.headers.get("retry-after"));
		if (wait !== undefined && wait > RETRY_AFTER_MAX_MS) return response;
		await discardBody(response);
		limit.clear();
		await sleep(wait ?? backoff(attempt), undefined, { signal });
	}
}

function httpError(response: Response, url: string): Error {
	const after = response.headers.get("retry-after");
	const status = [response.status, response.statusText].filter(Boolean).join(" ");
	const hint =
		response.status === 401 || response.status === 403
			? ` (login or bot block: ${RENDER_ADVICE}, or use a dedicated MCP tool for private content)`
			: "";
	return new Error(`HTTP ${status} for ${url}${after ? ` (retry after ${after})` : ""}${hint}`);
}

/**
 * An image the server sent, read whole up to `MAX_BODY_BYTES`. A cut image cannot be decoded, so one over the cap is
 * refused with a notice (nothing is saved: the whole file is a `curl -o` away), and so is a body that is not the image
 * its header claims: sending it on as an image would make the provider reject the whole conversation.
 */
async function fetchImage(response: Response, url: string, type: string): Promise<Fetched> {
	const where = response.url || url;
	const declared = Number(response.headers.get("content-length"));
	if (declared > MAX_BODY_BYTES) {
		await discardBody(response);
		return unsupported(
			`${where} is ${type}, ${formatBytes(declared, "compact")}, over web's ${MAX_BODY_MB} MB limit${UNREAD_NOTE}`,
		);
	}
	const { bytes, truncated, cut } = await readBytesCapped(response).catch((error: unknown) => {
		throw describeFetchError(error, url, 1);
	});
	if (truncated) return unsupported(`${where} is ${type}, over web's ${MAX_BODY_MB} MB limit${UNREAD_NOTE}`);
	if (cut) return unsupported(`${where} is ${type}, and its body was cut short in transit${UNREAD_NOTE}`);
	const mimeType = sniffImageType(bytes);
	if (!mimeType)
		return unsupported(
			`${where} is ${type} by its header, but the body is not a PNG, JPEG, GIF or WebP image${UNREAD_NOTE}`,
		);
	return { url: where, mimeType, bytes };
}

/** What `fetchResource` returns when the server confirmed the copy the request named validators for. */
const NOT_MODIFIED = Symbol("not modified");

async function fetchResource(
	url: string,
	signal: AbortSignal | undefined,
	options: FetchOptions,
	conditional: Record<string, string> | undefined,
	onResponse: (headers: Headers) => void,
): Promise<Fetched | typeof NOT_MODIFIED> {
	const limits: Deadline[] = [];
	try {
		return await fetchResourceWithin(url, signal, options, limits, conditional, onResponse);
	} finally {
		for (const limit of limits) limit.clear();
	}
}

async function fetchResourceWithin(
	url: string,
	signal: AbortSignal | undefined,
	options: FetchOptions,
	limits: Deadline[],
	conditional: Record<string, string> | undefined,
	onResponse: (headers: Headers) => void,
): Promise<Fetched | typeof NOT_MODIFIED> {
	const response = await fetchWithRetry(
		url,
		{
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,application/json,text/plain,*/*",
				"accept-language": language(),
				...conditional,
			},
		},
		options,
		signal,
		limits,
	);
	onResponse(response.headers);
	if (response.status === 304 && conditional) {
		await discardBody(response);
		return NOT_MODIFIED;
	}
	const type = response.headers.get("content-type") ?? "";
	if (INLINE_IMAGE_HEADERS.has(mediaType(type))) {
		if (response.ok) return fetchImage(response, url, mediaType(type));
		await discardBody(response);
		throw httpError(response, url);
	}
	if (isBinaryType(type)) {
		await discardBody(response);
		if (!response.ok) throw httpError(response, url);
		// Decoding binary as UTF-8 would flood the context with garbage.
		return unsupported(`${response.url} is ${mediaType(type)}, not text${UNREAD_NOTE}`);
	}
	// The timeout covers the body too: a slow stream reports like a slow connect, not as a bare abort.
	const {
		text: body,
		truncated,
		cut,
	} = await readCapped(response, type).catch((error: unknown) => {
		throw describeFetchError(error, url, 1);
	});
	if (!response.ok) throw httpError(response, url);
	const json = type.includes("json");
	const raw = json ? " and is shown raw, not pretty-printed" : "";
	// First, so the note survives the web tool's character cap. Cut JSON does not parse, so it is shown raw.
	const note = truncated
		? `[Truncated: the response is over ${MAX_BODY_MB} MB; only the first ${MAX_BODY_MB} MB was read${raw}. Download it with bash (curl -o) for the whole body.]\n\n`
		: cut
			? `${CUT_NOTE}${raw}. Fetch it again, or download it with bash (curl -o), for the whole body.]\n\n`
			: "";
	if (type.includes("html")) return note + describeHtml(body, response.url || url);
	if (json && !note) {
		try {
			return JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			return body;
		}
	}
	return note + body;
}

export function isBinaryType(contentType: string): boolean {
	const type = mediaType(contentType);
	if (!type) return false;
	if (
		type.startsWith("text/") ||
		/[+/](json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|toml|x-sh)$/.test(type)
	)
		return false;
	return (
		/^(image|audio|video|font)\//.test(type) ||
		/^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|octet-stream|wasm|x-bzip2|vnd\.)/.test(type)
	);
}

/**
 * The body decoded (see `decodeBody`), at most MAX_BODY_BYTES (5 MiB) of it; `truncated` when there was more, `cut`
 * when a compressed body ended early (the text is the part that arrived).
 */
export async function readCapped(
	response: Response,
	contentType: string,
): Promise<{ text: string; truncated: boolean; cut: boolean }> {
	const { bytes, truncated, cut } = await readBytesCapped(response);
	return { text: decodeBody(bytes, contentType, truncated || cut), truncated, cut };
}

/** The body's bytes, at most MAX_BODY_BYTES (5 MiB) of them; `truncated` when there was more, `cut` as in `readCapped`. */
async function readBytesCapped(response: Response): Promise<{ bytes: Buffer; truncated: boolean; cut: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: Buffer.alloc(0), truncated: false, cut: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	let cut = false;
	for (;;) {
		const next = await reader.read().catch((error: unknown) => {
			if (error instanceof TruncatedBodyError) return undefined;
			throw error;
		});
		cut = next === undefined;
		if (!next || next.done) break;
		const { value } = next;
		chunks.push(value);
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			truncated = true;
			break;
		}
	}
	await reader.cancel().catch(() => undefined);
	return { bytes: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES), truncated, cut };
}
