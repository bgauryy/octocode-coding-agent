import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { publicFetch, TruncatedBodyError } from "../src/web-guard.ts";

const servers: http.Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise((resolve) => {
					server.closeAllConnections();
					server.close(resolve);
				}),
		),
	);
});

/** A loopback server answering every request with `body` under `content-encoding: encoding`. */
async function serve(encoding: string, body: Buffer): Promise<string> {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain", "content-encoding": encoding }).end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

const TEXT = Array.from({ length: 4000 }, (_, index) => `line ${index} ${(index * 7919) % 10007}`).join("\n");
const ENCODERS = {
	gzip: zlib.gzipSync,
	deflate: zlib.deflateSync,
	br: zlib.brotliCompressSync,
} satisfies Record<string, (input: string) => Buffer>;

/** Every chunk read before the body ended or failed, and how it ended. */
async function readAll(response: Response): Promise<{ text: string; error: unknown }> {
	const reader = response.body!.getReader();
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return { text: Buffer.concat(chunks).toString("utf8"), error: undefined };
			chunks.push(value);
		}
	} catch (error) {
		return { text: Buffer.concat(chunks).toString("utf8"), error };
	}
}

describe("publicFetch compressed bodies", () => {
	it.each(Object.keys(ENCODERS) as Array<keyof typeof ENCODERS>)("decodes a whole %s body", async (encoding) => {
		const url = await serve(encoding, ENCODERS[encoding](TEXT));
		const response = await publicFetch(url, {}, { firstHopPrivate: true });
		expect(await response.text()).toBe(TEXT);
	});

	it.each(Object.keys(ENCODERS) as Array<keyof typeof ENCODERS>)(
		"delivers what arrived of a cut %s body, then fails it as truncated",
		async (encoding) => {
			const packed = ENCODERS[encoding](TEXT);
			const url = await serve(encoding, packed.subarray(0, Math.floor(packed.length / 2)));
			const response = await publicFetch(url, {}, { firstHopPrivate: true });
			const { text, error } = await readAll(response);
			expect(error).toBeInstanceOf(TruncatedBodyError);
			expect((error as Error).message).toBe("content truncated: compressed stream ended early");
			expect(text.length).toBeGreaterThan(0);
			expect(TEXT.startsWith(text)).toBe(true);
			expect(text.length).toBeLessThan(TEXT.length);
		},
	);

	it("rejects a whole-body read of a cut body instead of resolving with part of it", async () => {
		const packed = zlib.gzipSync(TEXT);
		const url = await serve("gzip", packed.subarray(0, packed.length - 8));
		const response = await publicFetch(url, {}, { firstHopPrivate: true });
		await expect(response.text()).rejects.toBeInstanceOf(TruncatedBodyError);
	});

	it("fails a corrupt body without calling it truncated", async () => {
		const packed = Buffer.from(zlib.gzipSync(TEXT));
		packed.fill(0xff, 40, 80);
		const url = await serve("gzip", packed);
		const response = await publicFetch(url, {}, { firstHopPrivate: true });
		const { error } = await readAll(response);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(TruncatedBodyError);
	});
});
