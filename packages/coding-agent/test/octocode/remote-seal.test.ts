import { describe, expect, it } from "vitest";
import {
	decodeKey,
	decodeNonce,
	directionKey,
	encodeKey,
	fingerprintOf,
	newKey,
	newNonce,
	open,
	roomOf,
	seal,
} from "../../src/octocode/web-daemon/remote/seal.ts";

describe("relay sealing", () => {
	const setup = () => {
		const link = newKey();
		const room = roomOf(link);
		const key = directionKey(link, room, newNonce(), newNonce(), "p2d");
		return { link, room, key };
	};

	it("round-trips text under a direction key, a room and a sequence number", () => {
		const { room, key } = setup();
		const a = seal(key, room, "p2d", 0, '{"hello":1}');
		const b = seal(key, room, "p2d", 1, '{"hello":1}');
		expect(a).not.toBe(b);
		expect(open(key, room, "p2d", 0, a)).toBe('{"hello":1}');
		expect(open(key, room, "p2d", 1, b)).toBe('{"hello":1}');
	});

	it("refuses another key, room, direction or sequence, a tampered frame and garbage", () => {
		const { room, key } = setup();
		const sealed = seal(key, room, "p2d", 3, "secret");
		expect(open(setup().key, room, "p2d", 3, sealed)).toBeUndefined();
		expect(open(key, roomOf(newKey()), "p2d", 3, sealed)).toBeUndefined();
		expect(open(key, room, "d2p", 3, sealed)).toBeUndefined();
		expect(open(key, room, "p2d", 4, sealed)).toBeUndefined();
		expect(open(key, room, "p2d", -1, sealed)).toBeUndefined();
		const bytes = Buffer.from(sealed, "base64");
		bytes[2] ^= 1;
		expect(open(key, room, "p2d", 3, bytes.toString("base64"))).toBeUndefined();
		expect(open(key, room, "p2d", 3, "not base64!")).toBeUndefined();
		expect(open(key, room, "p2d", 3, "")).toBeUndefined();
	});

	it("derives different keys per peer nonce, per direction and per room", () => {
		const link = newKey();
		const room = roomOf(link);
		const [d, p] = [newNonce(), newNonce()];
		const base = directionKey(link, room, d, p, "d2p");
		expect(directionKey(link, room, d, p, "d2p")).toEqual(base);
		expect(directionKey(link, room, d, p, "p2d")).not.toEqual(base);
		expect(directionKey(link, room, newNonce(), p, "d2p")).not.toEqual(base);
		expect(directionKey(link, room, d, newNonce(), "d2p")).not.toEqual(base);
		expect(directionKey(link, roomOf(newKey()), d, p, "d2p")).not.toEqual(base);
		// Swapping the nonces is a different salt, not the same key.
		expect(directionKey(link, room, p, d, "d2p")).not.toEqual(base);
	});

	it("matches the key schedule a browser computes with WebCrypto", async () => {
		const link = Buffer.alloc(32, 1);
		const room = roomOf(link);
		const [d, p] = [Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
		const base = await crypto.subtle.importKey("raw", link, "HKDF", false, ["deriveBits"]);
		const bits = await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: Buffer.concat([d, p]),
				info: new TextEncoder().encode(`octocode-remote v1|${room}|d2p`),
			},
			base,
			256,
		);
		expect(directionKey(link, room, d, p, "d2p")).toEqual(Buffer.from(bits));
	});

	it("encodes keys for a URL fragment and derives the room from the key, never the other way", () => {
		const key = newKey();
		const text = encodeKey(key);
		expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(decodeKey(text)).toEqual(key);
		expect(decodeKey(text.slice(1))).toBeUndefined();
		expect(decodeKey(`${text}=`)).toBeUndefined();
		expect(roomOf(key)).toMatch(/^[0-9a-f]{32}$/);
		expect(roomOf(key)).toBe(roomOf(key));
		expect(roomOf(key)).not.toBe(roomOf(newKey()));
		const nonce = newNonce();
		expect(decodeNonce(encodeKey(nonce))).toEqual(nonce);
		expect(decodeNonce("short")).toBeUndefined();
		expect(fingerprintOf(key)).toMatch(/^[0-9a-f]{8}$/);
		expect(fingerprintOf(key)).not.toBe(roomOf(key).slice(0, 8));
	});
});
