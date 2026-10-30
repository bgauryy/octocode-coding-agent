import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey, newKey, open, roomOf, seal } from "../../src/octocode/web-daemon/remote/seal.ts";

describe("relay sealing", () => {
	it("round-trips text under a key and a room, with a fresh nonce each time", () => {
		const key = newKey();
		const room = roomOf(key);
		const a = seal(key, room, '{"hello":1}');
		const b = seal(key, room, '{"hello":1}');
		expect(a).not.toBe(b);
		expect(open(key, room, a)).toBe('{"hello":1}');
		expect(open(key, room, b)).toBe('{"hello":1}');
	});

	it("refuses another key, another room, a tampered frame and garbage", () => {
		const key = newKey();
		const room = roomOf(key);
		const sealed = seal(key, room, "secret");
		expect(open(newKey(), room, sealed)).toBeUndefined();
		expect(open(key, roomOf(newKey()), sealed)).toBeUndefined();
		const bytes = Buffer.from(sealed, "base64");
		bytes[14] ^= 1;
		expect(open(key, room, bytes.toString("base64"))).toBeUndefined();
		expect(open(key, room, "not base64!")).toBeUndefined();
		expect(open(key, room, "")).toBeUndefined();
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
	});
});
