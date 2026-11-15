import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type HostLookup, pinnedFetch, publicFetch, TruncatedBodyError } from "../src/web-guard.ts";

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

describe("publicFetch private first hop", () => {
	it("refuses a host that resolves to a metadata address without connecting", async () => {
		let connections = 0;
		const server = http.createServer((_request, response) => response.end("hit"));
		server.on("connection", () => (connections += 1));
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const lookup = async () => [{ address: "169.254.169.254" }];
		await expect(
			publicFetch(`http://rebind.example.test:${port}/`, {}, { firstHopPrivate: true, lookup }),
		).rejects.toThrow(/cloud metadata address/);
		expect(connections).toBe(0);
	});

	it("refuses a metadata address when any resolved address is one", async () => {
		const lookup = async () => [{ address: "127.0.0.1" }, { address: "169.254.169.254" }];
		await expect(publicFetch("http://rebind.example.test:1/", {}, { firstHopPrivate: true, lookup })).rejects.toThrow(
			/cloud metadata address/,
		);
	});

	it("connects only to the resolved address", async () => {
		const hosts: Array<string | undefined> = [];
		const server = http.createServer((request, response) => {
			hosts.push(request.headers.host);
			response.end("pinned");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		let lookups = 0;
		const lookup = async () => {
			lookups += 1;
			return [{ address: "127.0.0.1" }];
		};
		const response = await publicFetch(`http://approved.example.test:${port}/`, {}, { firstHopPrivate: true, lookup });
		expect(await response.text()).toBe("pinned");
		expect(hosts).toEqual([`approved.example.test:${port}`]);
		expect(lookups).toBe(1);
	});
});

/** A loopback server: `/` redirects to `location`, `/login` and anything else answers "login page". */
async function redirecting(
	location: (port: number) => string,
	status = 302,
): Promise<{ port: number; paths: string[] }> {
	const paths: string[] = [];
	const server = http.createServer((request, response) => {
		paths.push(request.url ?? "");
		if (request.url === "/") response.writeHead(status, { location: location(port) }).end();
		else response.end("login page");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { port, paths };
}

describe("publicFetch redirects from an approved private page", () => {
	it("follows a redirect to another path of the same host and port", async () => {
		const { port, paths } = await redirecting(() => "/login");
		const response = await publicFetch(`http://127.0.0.1:${port}/`, {}, { firstHopPrivate: true });
		expect(await response.text()).toBe("login page");
		expect(paths).toEqual(["/", "/login"]);
	});

	it("follows an absolute same-origin redirect, and one reached through an approved name", async () => {
		const absolute = await redirecting((port) => `http://127.0.0.1:${port}/login?next=%2F`, 301);
		expect(await (await publicFetch(`http://127.0.0.1:${absolute.port}/`, {}, { firstHopPrivate: true })).text()).toBe(
			"login page",
		);
		const named = await redirecting(() => "/login");
		const lookup = async () => [{ address: "127.0.0.1" }];
		const response = await publicFetch(`http://dev.example.test:${named.port}/`, {}, { firstHopPrivate: true, lookup });
		expect(await response.text()).toBe("login page");
	});

	it("does not follow it without the first-hop allowance", async () => {
		const { port, paths } = await redirecting(() => "/login");
		await expect(publicFetch(`http://127.0.0.1:${port}/`, {})).rejects.toThrow(/Blocked private or non-public/);
		expect(paths).toEqual([]);
	});

	it("refuses a redirect to another port of the same host", async () => {
		const other = await redirecting(() => "/login");
		const { port, paths } = await redirecting(() => `http://127.0.0.1:${other.port}/login`);
		await expect(publicFetch(`http://127.0.0.1:${port}/`, {}, { firstHopPrivate: true })).rejects.toThrow(
			/Blocked private or non-public/,
		);
		expect(paths).toEqual(["/"]);
		expect(other.paths).toEqual([]);
	});

	it("refuses a redirect to another host on the same port", async () => {
		const { port, paths } = await redirecting((port) => `http://localhost:${port}/login`);
		await expect(publicFetch(`http://127.0.0.1:${port}/`, {}, { firstHopPrivate: true })).rejects.toThrow(
			/Blocked private or non-public/,
		);
		expect(paths).toEqual(["/"]);
	});

	it("refuses a redirect to a metadata address", async () => {
		const { port } = await redirecting(() => "http://169.254.169.254/latest/meta-data/");
		await expect(publicFetch(`http://127.0.0.1:${port}/`, {}, { firstHopPrivate: true })).rejects.toThrow(
			/Blocked private or non-public/,
		);
	});

	it("keeps the addresses of the approved hop: a name that resolves elsewhere on the redirect is not re-resolved", async () => {
		const { port, paths } = await redirecting(() => "/login");
		let lookups = 0;
		const lookup = async () => [{ address: lookups++ === 0 ? "127.0.0.1" : "169.254.169.254" }];
		const response = await publicFetch(`http://dev.example.test:${port}/`, {}, { firstHopPrivate: true, lookup });
		expect(await response.text()).toBe("login page");
		expect(paths).toEqual(["/", "/login"]);
		expect(lookups).toBe(1);
	});

	it("still bounds a same-origin redirect loop", async () => {
		const server = http.createServer((_request, response) => response.writeHead(302, { location: "/" }).end());
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await expect(publicFetch(`http://127.0.0.1:${port}/`, {}, { firstHopPrivate: true })).rejects.toThrow(
			/Too many redirects/,
		);
	});
});

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

describe("name resolution within the caller's deadline", () => {
	const neverResolves =
		(calls: string[]): HostLookup =>
		(name) => {
			calls.push(name);
			return new Promise(() => undefined);
		};

	it("publicFetch ends at the signal when the resolver never answers, after one lookup", async () => {
		const calls: string[] = [];
		const started = Date.now();
		await expect(
			publicFetch("http://blackhole.test/", { signal: AbortSignal.timeout(50) }, { lookup: neverResolves(calls) }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(calls).toEqual(["blackhole.test"]);
	});

	it("publicFetch with firstHopPrivate ends at the signal when the resolver never answers", async () => {
		const calls: string[] = [];
		await expect(
			publicFetch(
				"http://blackhole.test/",
				{ signal: AbortSignal.timeout(50) },
				{ lookup: neverResolves(calls), firstHopPrivate: true },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(calls).toHaveLength(1);
	});

	it("pinnedFetch ends at the signal when the resolver never answers", async () => {
		const calls: string[] = [];
		await expect(
			pinnedFetch(
				"http://blackhole.test/",
				{ signal: AbortSignal.timeout(50) },
				{ refuse: () => undefined, lookup: neverResolves(calls) },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(calls).toHaveLength(1);
	});
});

describe("first-hop addresses resolved by the caller", () => {
	it("connects to exactly those addresses without a lookup", async () => {
		const url = await serve("identity", Buffer.from("ok"));
		const port = new URL(url).port;
		const calls: string[] = [];
		const lookup: HostLookup = async (name) => {
			calls.push(name);
			return [{ address: "10.255.255.1" }];
		};
		const response = await publicFetch(
			`http://pinned.test:${port}/`,
			{},
			{ lookup, firstHopAddresses: ["127.0.0.1"], firstHopPrivate: true },
		);
		expect(await response.text()).toBe("ok");
		expect(calls).toEqual([]);
	});

	it("still refuses supplied private addresses when the first hop is not approved as private", async () => {
		await expect(
			publicFetch("http://pinned.test/", {}, { firstHopAddresses: ["127.0.0.1"], lookup: async () => [] }),
		).rejects.toThrow(/Blocked private/);
	});

	it("still refuses a supplied metadata address", async () => {
		await expect(
			publicFetch(
				"http://pinned.test/",
				{},
				{ firstHopAddresses: ["169.254.169.254"], firstHopPrivate: true, lookup: async () => [] },
			),
		).rejects.toThrow(/metadata/);
	});
});
