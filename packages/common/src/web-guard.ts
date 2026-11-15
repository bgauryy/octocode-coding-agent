import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline, Readable, type Transform } from "node:stream";
import zlib from "node:zlib";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { abortedOr, defaultLookup, type HostLookup, lookupWithin } from "./host-lookup.ts";
import { isBlockedIp, isMetadataIp } from "./ip-address.ts";

export { defaultLookup, type HostLookup, lookupWithin };

/** Redirect hops `web` follows; each target is checked before it is fetched. */
const MAX_REDIRECTS = 10;

/** What a URL's host reaches: only public addresses (listed), any non-public one, or nothing that resolves here. */
export type HostClass =
	| { kind: "public"; addresses: string[] }
	| { kind: "private" }
	| { kind: "unresolved"; error: unknown };

/** Releases the connection of a response whose body is not read. */
export const discardBody = (response: Response): Promise<void> =>
	(response.body?.cancel() ?? Promise.resolve()).catch(() => undefined);

/** Whether `url` is an http(s) URL: the only schemes the web and browser tools reach. */
export const isHttpUrl = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

/** A URL's hostname as a name or address: the brackets `URL` keeps around an IPv6 literal are dropped. */
export const bareHostname = (hostname: string): string => hostname.replace(/^\[|\]$/g, "");

/**
 * Classifies `url`'s host by its literal address or every address it resolves to (loopback, private, link-local cloud
 * metadata, … count as private). A name that does not resolve here is `unresolved`: another resolver (a browser's
 * own DNS, a hosts entry, a proxy) may still take it somewhere private.
 */
export async function classifyHost(url: URL, lookup: HostLookup = defaultLookup): Promise<HostClass> {
	const hostname = bareHostname(url.hostname);
	if (net.isIP(hostname))
		return isBlockedIp(hostname) ? { kind: "private" } : { kind: "public", addresses: [hostname] };
	let records: Array<{ address: string }>;
	try {
		records = await lookup(hostname);
	} catch (error) {
		return { kind: "unresolved", error };
	}
	if (records.length === 0) return { kind: "unresolved", error: new Error(`${hostname} has no addresses`) };
	if (records.some(({ address }) => isBlockedIp(address))) return { kind: "private" };
	return { kind: "public", addresses: records.map(({ address }) => address) };
}

/**
 * Whether `url`'s host is, or resolves to, a cloud metadata address. No mode runs such a request, so the check is its
 * own: `classifyHost` only says private, which `full` allows. A name that does not resolve here is not one.
 */
export async function reachesMetadata(url: URL, lookup: HostLookup = defaultLookup): Promise<boolean> {
	const hostname = bareHostname(url.hostname);
	if (net.isIP(hostname)) return isMetadataIp(hostname);
	try {
		return (await lookup(hostname)).some(({ address }) => isMetadataIp(address));
	} catch {
		return false;
	}
}

/** The refusal for a request to a cloud metadata address; no mode and no answer lets one through. */
export const metadataRefusal = (host: string): string =>
	`${host} is a cloud metadata address, which hands out this machine's credentials; Octocode refuses it in every mode. Do not retry it.`;

/** A connection, TLS or DNS failure: worth another try, unlike a refusal, a redirect or a timeout. */
export class NetworkError extends Error {
	constructor(cause: unknown) {
		super(errorMessage(cause), { cause });
		this.name = "NetworkError";
	}
}

export interface PublicFetchInit {
	/** `GET` (default) or `POST`. */
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	/** The request body (a `POST`); sent only with `redirect: 'error'`, because a redirect must not carry it elsewhere. */
	body?: string;
	/** `follow` (default) checks and follows redirects; `error` fails on the first one. */
	redirect?: "follow" | "error";
	signal?: AbortSignal;
}

/**
 * Requests `url` (a GET, or a POST with a body), checking it and every redirect target before requesting it: http(s)
 * only, and a host that resolves only to public addresses. The connection goes to the checked addresses, so a DNS
 * answer that changes after the check (rebinding) cannot point it somewhere private. `firstHopPrivate` lets the first
 * request (the URL the user approved as a `net.private` ask) reach a private address; every redirect target is still
 * checked, so a redirect never leads to another private address. That first request is resolved once too: it is
 * refused when any address is a cloud metadata address, and the connection goes to those addresses only. When it is a
 * private page, a redirect that stays on its origin (same scheme, host and port: the page's own login path, say) is
 * followed over those same addresses; a redirect to another host or port is checked as usual.
 */
export async function publicFetch(
	url: string,
	init: PublicFetchInit,
	options: {
		lookup?: HostLookup;
		sameHost?: boolean;
		firstHopPrivate?: boolean;
		/** Addresses the caller already resolved for the first URL's host: the first hop is checked and connected to these, not resolved again. */
		firstHopAddresses?: string[];
	} = {},
): Promise<Response> {
	if (init.body !== undefined && init.redirect !== "error")
		throw new Error("a request with a body must use redirect: 'error'");
	let target = new URL(url);
	const lookup = lookupWithin(options.lookup, init.signal);
	const supplied = options.firstHopAddresses;
	const firstLookup: HostLookup = supplied ? async () => supplied.map((address) => ({ address })) : lookup;
	// The approved private page: its origin and the addresses checked for it, which a redirect inside it reuses.
	let approvedPrivate: { origin: string; addresses: string[] } | undefined;
	for (let hop = 0; ; hop += 1) {
		if (!isHttpUrl(target)) throw new Error(`web fetches http(s) URLs only, not ${target.protocol}`);
		let addresses: string[];
		if (approvedPrivate?.origin === target.origin) addresses = approvedPrivate.addresses;
		else if (hop === 0 && options.firstHopPrivate) {
			addresses = await abortedOr(init.signal, () =>
				checkedAddresses(target, firstLookup, (address) =>
					isMetadataIp(address) ? metadataRefusal(target.host) : undefined,
				),
			);
			if (addresses.some(isBlockedIp)) approvedPrivate = { origin: target.origin, addresses };
		} else addresses = await abortedOr(init.signal, () => publicAddresses(target, hop === 0 ? firstLookup : lookup));
		const response = await send(target, init, addresses);
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || location === null) return response;
		await discardBody(response);
		if (init.redirect === "error")
			throw new Error(`${target.host} answered with a redirect (HTTP ${response.status}); it is not followed`);
		if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
		const next = new URL(location, target);
		if (options.sameHost && !sameSite(target, next)) throw new CrossHostRedirect(target, next, response.status);
		target = next;
	}
}

/** The public addresses `url`'s host resolves to; throws when it is private or does not resolve. */
async function publicAddresses(url: URL, lookup?: HostLookup): Promise<string[]> {
	const host = await classifyHost(url, lookup);
	if (host.kind === "unresolved") throw new Error(`Could not resolve ${url.hostname}: ${errorMessage(host.error)}`);
	if (host.kind === "private")
		throw new Error(
			`Blocked private or non-public address: ${url.host}. Do not retry it. A redirect is followed to a private address only within the host and port the user approved; a local page the user wants read is a \`web\` URL of its own (the user is asked first), or use \`browser\`.`,
		);
	return host.addresses;
}

/**
 * One request to `url` without following redirects, for a caller with its own address rule (loopback and private
 * hosts allowed, say): every address the host resolves to goes through `refuse`, which returns the reason to refuse it
 * or undefined. The connection then goes to those addresses only, so a DNS answer that changes after the check cannot
 * point it elsewhere. A host that does not resolve is refused too.
 */
export async function pinnedFetch(
	url: string,
	init: PublicFetchInit,
	options: { refuse: (address: string) => string | undefined; lookup?: HostLookup },
): Promise<Response> {
	const target = new URL(url);
	if (!isHttpUrl(target)) throw new Error(`only http(s) URLs are requested, not ${target.protocol}`);
	const lookup = lookupWithin(options.lookup, init.signal);
	return send(target, init, await abortedOr(init.signal, () => checkedAddresses(target, lookup, options.refuse)));
}

/** Every address `url`'s host is, or resolves to (once), after `refuse` accepted each; throws on the first refusal or when it does not resolve. */
async function checkedAddresses(
	url: URL,
	lookup: HostLookup | undefined,
	refuse: (address: string) => string | undefined,
): Promise<string[]> {
	const hostname = bareHostname(url.hostname);
	let addresses: string[];
	if (net.isIP(hostname)) addresses = [hostname];
	else {
		try {
			addresses = (await (lookup ?? defaultLookup)(hostname)).map(({ address }) => address);
		} catch (error) {
			throw new Error(`Could not resolve ${hostname}: ${errorMessage(error)}`, { cause: error });
		}
		if (addresses.length === 0) throw new Error(`Could not resolve ${hostname}: no addresses`);
	}
	for (const address of addresses) {
		const reason = refuse(address);
		if (reason) throw new Error(reason);
	}
	return addresses;
}

/** Statuses whose response has no body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** One request without following redirects; `addresses` (when given) are the only ones the connection may use. */
function send(target: URL, init: PublicFetchInit, addresses: string[] | undefined): Promise<Response> {
	const { signal } = init;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		let incoming: http.IncomingMessage | undefined;
		const onAbort = () => {
			request.destroy(signal!.reason);
			incoming?.destroy(signal!.reason);
		};
		const client = target.protocol === "https:" ? https : http;
		// No pooled agent: a reused socket could lead to an address this request did not check.
		const request = client.request(
			target,
			{
				method: init.method ?? "GET",
				agent: false,
				headers: {
					"accept-encoding": "gzip, deflate, br",
					...(init.body !== undefined && { "content-length": String(Buffer.byteLength(init.body)) }),
					...init.headers,
				},
				...(addresses && { lookup: pinnedLookup(addresses) }),
			},
			(response) => {
				incoming = response;
				response.once("close", () => signal?.removeEventListener("abort", onAbort));
				try {
					resolve(toResponse(target, response));
				} catch (error) {
					response.destroy();
					reject(new NetworkError(error));
				}
			},
		);
		request.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.aborted ? signal.reason : new NetworkError(error));
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		request.end(init.body);
	});
}

/** The Fetch API view of a Node response: headers as sent, the body decompressed, `url` the address requested. */
function toResponse(target: URL, response: http.IncomingMessage): Response {
	const status = response.statusCode ?? 0;
	if (status < 200 || status > 599) throw new Error(`invalid HTTP status ${status}`);
	const headers = new Headers();
	for (let index = 0; index + 1 < response.rawHeaders.length; index += 2)
		headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
	let body: ReadableStream<Uint8Array> | null = null;
	if (NULL_BODY_STATUSES.has(status)) response.resume();
	else {
		const decoder = decompressor(response.headers["content-encoding"]);
		body = decoder ? decodedBody(response, decoder) : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
	}
	const result = new Response(body, {
		status,
		statusText: (response.statusMessage ?? "").replace(/[^\t\x20-\x7e\x80-\xff]/g, ""),
		headers,
	});
	Object.defineProperty(result, "url", { value: target.href });
	return result;
}

/**
 * A compressed body that ended before its compressed stream did. Every byte decoded before the cut was delivered
 * first, so a reader that catches this keeps the partial content and knows it is partial.
 */
export class TruncatedBodyError extends Error {
	constructor(cause?: unknown) {
		super("content truncated: compressed stream ended early", { cause });
		this.name = "TruncatedBodyError";
	}
}

/** zlib's report of input that ended inside the compressed stream (gzip, deflate and Brotli alike). */
const isCutStream = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "Z_BUF_ERROR";

/** Decoded chunks a body buffers before the decoder pauses for the reader. */
const DECODED_QUEUE_CHUNKS = 16;

/**
 * The decoded body as a pull stream. The reader gets every decoded chunk before an error: a cut stream ends with
 * `TruncatedBodyError`, a corrupt one or a failed connection with its own error. (`Readable.toWeb` would drop the
 * chunks still queued when the error arrives.)
 */
function decodedBody(response: http.IncomingMessage, decoder: Transform): ReadableStream<Uint8Array> {
	const queue: Buffer[] = [];
	let finished = false;
	let failure: unknown;
	let wake: (() => void) | undefined;
	const settle = (error?: unknown) => {
		if (finished) return;
		finished = true;
		failure = error;
		wake?.();
	};
	// The response's own failure (an abort, a reset) reaches the decoder through the pipeline and is settled there.
	pipeline(response, decoder, () => undefined);
	decoder.on("data", (chunk: Buffer) => {
		queue.push(chunk);
		if (queue.length >= DECODED_QUEUE_CHUNKS) decoder.pause();
		wake?.();
	});
	decoder.once("end", () => settle());
	decoder.once("error", (error) => settle(isCutStream(error) ? new TruncatedBodyError(error) : error));
	decoder.once("close", () => settle(new TruncatedBodyError()));
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				while (queue.length === 0 && !finished) {
					decoder.resume();
					await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
				}
				const chunk = queue.shift();
				if (chunk) controller.enqueue(chunk);
				else if (failure === undefined) controller.close();
				else controller.error(failure);
			},
			cancel(reason) {
				response.destroy();
				decoder.destroy();
				settle(reason);
			},
		},
		// No read-ahead: the queue is empty whenever an error is reported, so it never drops decoded bytes.
		{ highWaterMark: 0 },
	);
}

/**
 * A stream that undoes the Content-Encoding the request accepted. Each chunk is flushed as it arrives, so a cut stream
 * still yields what arrived before `decodedBody` reports the cut.
 */
function decompressor(encoding: string | undefined): Transform | undefined {
	switch (encoding?.trim().toLowerCase()) {
		case "gzip":
		case "x-gzip":
			return zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH });
		case "deflate":
			return zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH });
		case "br":
			return zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH });
		default:
			return undefined;
	}
}

/** A DNS lookup that answers only with the checked addresses. */
function pinnedLookup(addresses: string[]): net.LookupFunction {
	const entries = addresses.map((address) => ({ address, family: net.isIP(address) }));
	return (_hostname, options, callback) => {
		if (options.all) return callback(null, entries);
		const wanted = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
		const entry = entries.find(({ family }) => !wanted || family === wanted) ?? entries[0];
		callback(null, entry.address, entry.family);
	};
}

/** A redirect `publicFetch` did not follow because it leaves the host (with `sameHost`); the caller decides. */
export class CrossHostRedirect extends Error {
	readonly from: URL;
	readonly to: URL;
	readonly status: number;
	constructor(from: URL, to: URL, status: number) {
		super(`${from.href} redirects (HTTP ${status}) to another host: ${to.href}`);
		this.from = from;
		this.to = to;
		this.status = status;
	}
}

/** Same host (a leading `www.` ignored), and no downgrade from https to http. */
function sameSite(from: URL, to: URL): boolean {
	const host = (url: URL) => url.hostname.replace(/^www\./i, "").toLowerCase();
	return host(from) === host(to) && !(from.protocol === "https:" && to.protocol === "http:");
}
