/**
 * What travels between a remote page and the daemon through a relay (wire version 1; `docs/remote.md` is the
 * reference). The relay sees `RelayFrame`s whose `data` is a `WireFrame`: two plaintext handshake messages that carry
 * only public nonces, then sealed messages (`seal.ts`) whose plaintext is a `TunnelRequest` or `TunnelResponsePayload`.
 * Each direction counts messages from 0 in `s`, and the receiver accepts exactly the next number, so a relay that
 * stores frames can neither replay nor reorder them, and keys are per connection, so it cannot use them elsewhere.
 */
import { decodeNonce, WIRE_VERSION } from "./seal.ts";

/** Relay to host, and host to relay. A peer's own socket carries bare `WireFrame` strings. */
export type RelayFrame =
	| { type: "peer.open"; peer: string }
	| { type: "peer.message"; peer: string; data: string }
	| { type: "peer.close"; peer: string };

/**
 * One text message on a peer's socket. `hello` (daemon, first, after the relay announces the peer) and `join` (page,
 * answering) are plaintext and carry a 16-byte nonce as 22 base64url characters; `msg` carries sealed base64.
 */
export type WireFrame =
	| { v: typeof WIRE_VERSION; t: "hello"; nonce: string }
	| { v: typeof WIRE_VERSION; t: "join"; nonce: string }
	| { v: typeof WIRE_VERSION; t: "msg"; s: number; d: string };

/** Sealed, from the page to the daemon. */
export type TunnelRequest =
	| { kind: "request"; id: string; method: "GET" | "POST"; path: string; body?: string }
	| { kind: "stream.open"; stream: string; path: string; cursor?: unknown }
	| { kind: "stream.close"; stream: string };

/** Sealed, from the daemon to the page. */
export type TunnelResponsePayload =
	| { kind: "hello"; access: "view" | "control"; build: string }
	| { kind: "response"; id: string; status: number; body: string }
	| { kind: "stream.message"; stream: string; data: string }
	| { kind: "stream.end"; stream: string; code: number };

/** Where a host and a peer meet at a relay; the room is derived from the link's key. */
const relayRoutes = {
	host: (room: string) => `/v1/rooms/${room}/host`,
	peer: (room: string) => `/v1/rooms/${room}/peer`,
};

/** The URL the daemon dials for a room: the relay address with its path prefix kept (`wss://h/octo` -> `wss://h/octo/v1/...`). */
export function relayHostUrl(relayUrl: string, room: string): string {
	const url = new URL(relayUrl);
	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "") + relayRoutes.host(room);
	return url.href;
}

const ID = /^[\w.-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_SEALED_CHARS = 16 * 1024 * 1024;
/**
 * A request target: an origin-form path and query made only of RFC 3986 characters (unreserved, sub-delims, `:`, `@`,
 * `/`, `?` and percent-encoded octets), at most 2048 of them. Nothing Node's HTTP client would refuse can pass.
 */
const PATH = /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2}){0,2048}$/;
const MAX_PATH_CHARS = 8192;

/** Whether a request target is acceptable to forward; the tunnel answers an error for one that is not. */
export const validPath = (path: string): boolean => PATH.test(path);

/** A parsed, shape-checked wire frame of the current version; undefined for anything else, including old formats. */
export function parseWire(text: string): WireFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const frame = value as Record<string, unknown>;
	if (frame.v !== WIRE_VERSION) return undefined;
	if (frame.t === "hello" || frame.t === "join") {
		if (typeof frame.nonce !== "string" || !decodeNonce(frame.nonce)) return undefined;
		return { v: WIRE_VERSION, t: frame.t, nonce: frame.nonce };
	}
	if (frame.t === "msg") {
		if (!Number.isSafeInteger(frame.s) || (frame.s as number) < 0) return undefined;
		if (typeof frame.d !== "string" || frame.d.length > MAX_SEALED_CHARS || !BASE64.test(frame.d)) return undefined;
		return { v: WIRE_VERSION, t: "msg", s: frame.s as number, d: frame.d };
	}
	return undefined;
}

/**
 * A parsed, shape-checked tunnel request; undefined for anything else (that ends the peer). A `path` that is not a valid
 * target is kept so the tunnel can answer an error and the peer's other requests carry on.
 */
export function parseTunnelRequest(text: string): TunnelRequest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const message = value as Record<string, unknown>;
	switch (message.kind) {
		case "request":
			if (
				typeof message.id !== "string" ||
				!ID.test(message.id) ||
				(message.method !== "GET" && message.method !== "POST") ||
				typeof message.path !== "string" ||
				message.path.length > MAX_PATH_CHARS ||
				(message.body !== undefined && typeof message.body !== "string")
			)
				return undefined;
			return {
				kind: "request",
				id: message.id,
				method: message.method,
				path: message.path,
				...(message.body !== undefined ? { body: message.body } : {}),
			};
		case "stream.open":
			if (typeof message.stream !== "string" || !ID.test(message.stream)) return undefined;
			if (typeof message.path !== "string" || message.path.length > MAX_PATH_CHARS) return undefined;
			return {
				kind: "stream.open",
				stream: message.stream,
				path: message.path,
				...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
			};
		case "stream.close":
			if (typeof message.stream !== "string" || !ID.test(message.stream)) return undefined;
			return { kind: "stream.close", stream: message.stream };
		default:
			return undefined;
	}
}

/** A relay frame as the host reads it; undefined for anything else. */
export function parseRelayFrame(text: string): RelayFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const frame = value as Record<string, unknown>;
	if (typeof frame.peer !== "string" || !ID.test(frame.peer)) return undefined;
	if (frame.type === "peer.open" || frame.type === "peer.close") return { type: frame.type, peer: frame.peer };
	if (frame.type === "peer.message" && typeof frame.data === "string" && frame.data.length <= MAX_SEALED_CHARS + 1024)
		return { type: "peer.message", peer: frame.peer, data: frame.data };
	return undefined;
}
