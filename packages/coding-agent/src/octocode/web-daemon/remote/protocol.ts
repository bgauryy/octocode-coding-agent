/**
 * What travels between a remote page and the daemon through a relay. The relay sees only `RelayFrame`s whose `data`
 * is sealed (`seal.ts`); the sealed text is a `TunnelMessage`. Every message carries a per-direction `seq` that must
 * grow, so a relay that stores frames cannot replay one.
 */

/** Relay to host, and host to relay. A peer's own socket carries bare sealed strings. */
export type RelayFrame =
	| { type: "peer.open"; peer: string }
	| { type: "peer.message"; peer: string; data: string }
	| { type: "peer.close"; peer: string };

/** Sealed, from the page to the daemon. */
export type TunnelRequest =
	| { seq: number; kind: "request"; id: string; method: "GET" | "POST"; path: string; body?: string }
	| { seq: number; kind: "stream.open"; stream: string; path: string; cursor?: unknown }
	| { seq: number; kind: "stream.close"; stream: string };

/** A response before the relay adds its sequence number. */
export type TunnelResponsePayload =
	| { kind: "hello"; access: "view" | "control"; build: string }
	| { kind: "response"; id: string; status: number; body: string }
	| { kind: "stream.message"; stream: string; data: string }
	| { kind: "stream.end"; stream: string; code: number };

/** Sealed, from the daemon to the page. */
export type TunnelResponse = TunnelResponsePayload & { seq: number };

export const RELAY_PROTOCOL_VERSION = 1 as const;
/** Where a host and a peer meet at a relay; the room is derived from the link's key. */
export const relayRoutes = {
	host: (room: string) => `/v1/rooms/${room}/host`,
	peer: (room: string) => `/v1/rooms/${room}/peer`,
};
const ROOM = /^[0-9a-f]{32}$/;
export const isRoom = (value: string): boolean => ROOM.test(value);

const ID = /^[\w.-]{1,64}$/;
const PATH = /^\/(?!\/)[^\s]{0,2048}$/;

/** A parsed, shape-checked tunnel request; undefined for anything else. The daemon's own server checks the rest. */
export function parseTunnelRequest(text: string): TunnelRequest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 0) return undefined;
	const seq = message.seq as number;
	switch (message.kind) {
		case "request":
			if (
				typeof message.id !== "string" ||
				!ID.test(message.id) ||
				(message.method !== "GET" && message.method !== "POST") ||
				typeof message.path !== "string" ||
				!PATH.test(message.path) ||
				(message.body !== undefined && typeof message.body !== "string")
			)
				return undefined;
			return {
				seq,
				kind: "request",
				id: message.id,
				method: message.method,
				path: message.path,
				...(message.body !== undefined ? { body: message.body } : {}),
			};
		case "stream.open":
			if (typeof message.stream !== "string" || !ID.test(message.stream)) return undefined;
			if (typeof message.path !== "string" || !PATH.test(message.path)) return undefined;
			return {
				seq,
				kind: "stream.open",
				stream: message.stream,
				path: message.path,
				...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
			};
		case "stream.close":
			if (typeof message.stream !== "string" || !ID.test(message.stream)) return undefined;
			return { seq, kind: "stream.close", stream: message.stream };
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
	if (frame.type === "peer.message" && typeof frame.data === "string" && frame.data.length <= 16 * 1024 * 1024)
		return { type: "peer.message", peer: frame.peer, data: frame.data };
	return undefined;
}
