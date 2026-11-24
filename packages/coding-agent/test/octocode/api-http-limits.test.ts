import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/octocode/api/events.ts";
import { API_HTTP_LIMITS, ApiServer } from "../../src/octocode/api/server.ts";

/** The API's loopback HTTP listener against peers that never finish a request or flood it with connections. */
const servers: ApiServer[] = [];
const sockets: net.Socket[] = [];
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => void uncaught.push(error);
beforeEach(() => {
	uncaught.length = 0;
	process.on("uncaughtException", onUncaught);
});
afterEach(async () => {
	process.off("uncaughtException", onUncaught);
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
	limits?: typeof API_HTTP_LIMITS,
	dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown> = async (_method, params) => params,
) {
	const server = new ApiServer(dispatch, new EventLog(), "fixture-token");
	servers.push(server);
	await server.listenHttp(0, limits);
	return Number(new URL(server.httpUrl!).port);
}

/**
 * Opens a raw connection and sends the start of a request that never ends. `connected` resolves once the connection is
 * established (the server accepts connections in that order); `closed` when the server closes it, with what it sent.
 */
function halfSent(port: number): { connected: Promise<void>; closed: Promise<string> } {
	const socket = net.connect({ host: "127.0.0.1", port });
	sockets.push(socket);
	let received = "";
	socket.on("error", () => undefined);
	socket.on("data", (chunk) => {
		received += chunk.toString();
	});
	const connected = new Promise<void>((resolve) =>
		socket.on("connect", () => {
			socket.write("POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n");
			resolve();
		}),
	);
	return { connected, closed: new Promise((resolve) => socket.on("close", () => resolve(received))) };
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "still open"> =>
	Promise.race([promise, new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), ms))]);

function post(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/rpc",
				method: "POST",
				headers: { authorization: "Bearer fixture-token" },
			},
			(reply) => {
				const chunks: Buffer[] = [];
				reply.on("data", (chunk: Buffer) => chunks.push(chunk));
				reply.on("end", () =>
					resolve({ status: reply.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
				);
			},
		);
		request.on("error", reject);
		request.end(JSON.stringify(body));
	});
}

describe("API HTTP listener limits", () => {
	it("uses the same 10 s header and request timeouts as the daemon and the board", () => {
		expect(API_HTTP_LIMITS).toMatchObject({ headersTimeout: 10_000, requestTimeout: 10_000 });
	});

	it("closes a connection whose request headers never finish", async () => {
		const port = await serve({
			...API_HTTP_LIMITS,
			headersTimeout: 200,
			requestTimeout: 200,
			connectionsCheckingInterval: 50,
		});
		const peer = halfSent(port);
		expect(await within(peer.closed, 3000)).toMatch(/^HTTP\/1\.1 408/);
	});

	it("does not cut a slow answer once the request has arrived", async () => {
		// Time is the contract here: the answer takes longer than the request timeout, which must not cut it.
		const requestTimeout = 20;
		const port = await serve(
			{ ...API_HTTP_LIMITS, headersTimeout: requestTimeout, requestTimeout, connectionsCheckingInterval: 10 },
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 6 * requestTimeout));
				return "late";
			},
		);
		const response = await post(port, { jsonrpc: "2.0", id: 1, method: "slow" });
		expect(response).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: "late" } });
	});

	it("refuses connections over the cap and still serves once they go", async () => {
		const port = await serve();
		const held = Array.from({ length: API_HTTP_LIMITS.maxConnections }, () => halfSent(port));
		// Every held connection is established before the extra one starts, so the server takes them first.
		await Promise.all(held.map((peer) => peer.connected));
		const extra = halfSent(port);
		// Refused with no answer; one the server took would be answered 408 when its headers time out.
		expect(await extra.closed).toBe("");
		for (const socket of sockets.splice(0)) socket.destroy();
		await Promise.all(held.map((peer) => peer.closed));
		// The server frees a slot when it sees a close; a request sent before that is refused and sent again.
		await vi.waitFor(async () => {
			const response = await post(port, { jsonrpc: "2.0", id: 2, method: "echo", params: { ok: true } });
			expect(response).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 2, result: { ok: true } } });
		});
	});

	it("survives a client that resets in the middle of a request body", async () => {
		const port = await serve();
		for (let round = 0; round < 20; round++) {
			await new Promise<void>((resolve) => {
				const socket = net.connect({ host: "127.0.0.1", port });
				socket.on("error", () => undefined);
				socket.on("close", () => resolve());
				socket.on("connect", () => {
					socket.write(
						'POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer fixture-token\r\nContent-Length: 100\r\n\r\n{"jsonrpc',
					);
					setTimeout(() => socket.resetAndDestroy(), 5);
				});
			});
		}
		// The server answers a request after it handled every reset before it: any error they raised is in by now.
		const response = await post(port, { jsonrpc: "2.0", id: 3, method: "echo", params: {} });
		expect(response.status).toBe(200);
		expect(uncaught).toEqual([]);
	});
});
