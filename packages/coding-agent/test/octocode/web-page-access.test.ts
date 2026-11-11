import type { IncomingMessage } from "node:http";
import { APPLICATION_PROTOCOL_VERSION } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { bearerOf, ownHost, ownOrigin, readHello } from "../../src/octocode/workspace/page-access.ts";

const ORIGIN = "http://127.0.0.1:4100";
const request = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;
const hello = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

/** The one access check both web page servers (a session's own and the user-level daemon) apply. */
describe("web page access", () => {
	it("accepts only the server's own Host and, when sent or required, its own Origin", () => {
		expect(ownHost(request({ host: "127.0.0.1:4100" }), ORIGIN)).toBe(true);
		for (const host of ["localhost:4100", "127.0.0.1:4101", "evil.example", undefined])
			expect(ownHost(request({ host }), ORIGIN)).toBe(false);
		expect(ownOrigin(request({}), ORIGIN)).toBe(true);
		expect(ownOrigin(request({}), ORIGIN, true)).toBe(false);
		expect(ownOrigin(request({ origin: ORIGIN }), ORIGIN, true)).toBe(true);
		for (const origin of ["https://evil.example", "http://localhost:4100", "null"])
			expect(ownOrigin(request({ origin }), ORIGIN)).toBe(false);
	});

	it("reads the bearer token with a case-insensitive scheme, from the Authorization header only", () => {
		expect(bearerOf(request({ authorization: "Bearer tok" }))).toBe("tok");
		expect(bearerOf(request({ authorization: "bearer tok" }))).toBe("tok");
		expect(bearerOf(request({ authorization: "BEARER tok" }))).toBe("tok");
		expect(bearerOf(request({}))).toBe("");
	});

	it("parses a socket hello and names the refusal for anything else", () => {
		expect(readHello(hello("tok"), false)).toEqual({ token: "tok" });
		expect(readHello(hello({ token: "tok", protocolVersion: APPLICATION_PROTOCOL_VERSION }), false)).toEqual({
			token: "tok",
		});
		const cursor = { sessionId: "s", epoch: "e", sequence: 3 };
		expect(readHello(hello({ token: "tok", protocolVersion: APPLICATION_PROTOCOL_VERSION, cursor }), false)).toEqual({
			token: "tok",
			cursor,
		});
		expect(readHello(hello("tok"), true)).toEqual({ refusal: "Reopen the workspace" });
		expect(readHello(hello("{not json"), false)).toEqual({ refusal: "Invalid handshake" });
		expect(readHello(hello({ token: "tok", protocolVersion: -1 }), false)).toEqual({
			refusal: "Unsupported protocol; reopen the workspace",
		});
		expect(
			readHello(
				hello({ token: "tok", protocolVersion: APPLICATION_PROTOCOL_VERSION, cursor: { ...cursor, sequence: -1 } }),
				false,
			),
		).toEqual({ refusal: "Invalid cursor" });
	});
});
