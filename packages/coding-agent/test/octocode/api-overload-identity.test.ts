import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { ApiCallError, ApiClient } from "../../src/octocode/api/client.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ERR } from "../../src/octocode/api/protocol.ts";
import { removeSocket, socketPath } from "../../src/octocode/api/registry.ts";
import { tmp } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const refusal = {
	jsonrpc: "2.0",
	id: null,
	error: { code: ERR.unavailable, message: "Too many connections", data: { execution: "not-sent" } },
};

async function replies(value: unknown) {
	const file = socketPath(tmp("api-admission-"), "s");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
		socket.end(`${JSON.stringify(value)}\n`);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(file, resolve);
	});
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((r) => server.close(() => r()));
		removeSocket(file);
	});
	return new ApiClient({ socket: file });
}

it.runIf(process.platform !== "win32")(
	"reports a saturated socket as non-delivery for calls and subscriptions, then recovers admission",
	async () => {
		let dispatched = 0;
		const server = new ApiServer(async () => ++dispatched, new EventLog(), "fixture");
		const file = socketPath(tmp("api-capacity-"), "s");
		await server.listenUnix(file);
		const peers: net.Socket[] = [];
		cleanup.push(async () => {
			for (const peer of peers) peer.destroy();
			await server.close();
		});
		for (let i = 0; i < 16; i++) {
			const peer = net.connect(file);
			peers.push(peer);
			peer.on("error", () => undefined);
			await once(peer, "connect");
			const response = once(peer, "data");
			peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" })}\n`);
			expect(JSON.parse(String((await response)[0])).result).toBe(i + 1);
		}
		const client = new ApiClient({ socket: file });
		for (const request of [
			() => client.call("message.send", {}, { timeoutMs: 1000 }),
			() => client.watch(() => undefined),
		]) {
			const error: unknown = await request().catch((error: unknown) => error);
			expect(error).toBeInstanceOf(ApiCallError);
			expect(error).toMatchObject({ code: ERR.unavailable, data: { execution: "not-sent" } });
		}
		expect(dispatched).toBe(16);
		const ended = once(peers[0], "end");
		peers[0].end();
		await ended;
		expect(await client.call("ping", {}, { timeoutMs: 1000 })).toBe(17);
	},
);

it.each([
	{ ...refusal, id: 99 },
	{ jsonrpc: "2.0", id: null, result: "wrong identity" },
	{ ...refusal, result: "ambiguous envelope" },
	{ ...refusal, method: "event" },
	{ ...refusal, error: { ...refusal.error, code: ERR.internal } },
	{ ...refusal, error: { code: ERR.unavailable, message: "missing non-delivery proof" } },
	{ ...refusal, error: { ...refusal.error, message: 42 } },
	{ ...refusal, error: { ...refusal.error, data: { execution: "unknown" } } },
])("keeps identity validation for a reply outside the admission-error contract: %j", async (reply) => {
	const client = await replies(reply);
	await expect(client.call("ping")).rejects.toThrow("Invalid API response identity");
});

it("does not accept a null-id connection refusal over HTTP", async () => {
	const server = http.createServer((_request, response) => response.end(JSON.stringify(refusal)));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
	await expect(new ApiClient({ http: { url, token: "fixture" } }).call("ping")).rejects.toThrow(
		"Invalid API response identity",
	);
});

it.runIf(process.platform !== "win32")(
	"keeps a refused connection readable until its client has the refusal, so a request written late is not a transport failure",
	async () => {
		const server = new ApiServer(async () => "pong", new EventLog(), "fixture");
		const file = socketPath(tmp("api-linger-"), "s");
		await server.listenUnix(file);
		const peers: net.Socket[] = [];
		cleanup.push(async () => {
			for (const peer of peers) peer.destroy();
			await server.close();
		});
		for (let i = 0; i < 16; i++) {
			const peer = net.connect(file);
			peers.push(peer);
			peer.on("error", () => undefined);
			await once(peer, "connect");
			const response = once(peer, "data");
			peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" })}\n`);
			await response;
		}
		// The seventeenth client is slow: its request leaves only after the server has already answered and ended its side.
		// Half-open, so this side can still write after it read the server's end, as a request already in flight would.
		const late = net.connect({ path: file, allowHalfOpen: true });
		peers.push(late);
		const errors: Error[] = [];
		late.on("error", (error) => errors.push(error));
		late.setEncoding("utf8");
		let received = "";
		late.on("data", (chunk: string) => {
			received += chunk;
		});
		await once(late, "end");
		expect(JSON.parse(received)).toMatchObject({
			error: { code: ERR.unavailable, data: { execution: "not-sent", reason: "overloaded" } },
		});
		const written = new Promise<Error | null | undefined>((resolve) =>
			late.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "message.send", params: { text: "x".repeat(256 * 1024) } })}\n`,
				resolve,
			),
		);
		expect(await written).toBeFalsy();
		const closed = once(late, "close");
		late.end();
		expect((await closed)[0]).toBe(false);
		expect(errors).toEqual([]);
	},
);
