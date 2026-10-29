import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/octocode/api/events.ts";
import { MAX_FRAME_BYTES } from "../../src/octocode/api/protocol.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";

const servers: ApiServer[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture() {
	const dispatch = vi.fn(async (_method: string, params: Record<string, unknown>) => params);
	const createServer = vi.spyOn(http, "createServer");
	const server = new ApiServer(dispatch, new EventLog(), "fixture-token");
	servers.push(server);
	await server.listenHttp(0);
	const transport = createServer.mock.results[0].value as http.Server;
	createServer.mockRestore();
	return { server, transport, dispatch };
}

async function sendBody(server: ApiServer, transport: http.Server, body: Buffer, split: number) {
	const firstChunk = new Promise<void>((resolve) => {
		transport.once("request", (request) => request.once("data", () => resolve()));
	});
	let request!: http.ClientRequest;
	const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
		request = http.request(
			`${server.httpUrl}/rpc`,
			{ method: "POST", headers: { authorization: "Bearer fixture-token" } },
			(reply) => {
				const chunks: Buffer[] = [];
				reply.on("data", (chunk: Buffer) => chunks.push(chunk));
				reply.on("error", reject);
				reply.on("end", () =>
					resolve({ status: reply.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
				);
			},
		);
		request.on("error", reject);
	});
	request.write(body.subarray(0, split));
	await firstChunk;
	request.end(body.subarray(split));
	return response;
}

describe("HTTP API request body decoding", () => {
	it.each([
		["é", 1],
		["€", 1],
		["€", 2],
		["😀", 1],
		["😀", 2],
		["😀", 3],
	] as const)("preserves %s split after byte %i", async (character, offset) => {
		const { server, transport, dispatch } = await fixture();
		const text = `hello ${character} שלום`;
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { text } }));
		const response = await sendBody(server, transport, body, body.indexOf(Buffer.from(character)) + offset);
		expect(response).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { text } } });
		expect(dispatch).toHaveBeenCalledWith("echo", { text }, {});
	});

	it("rejects an oversized multibyte body by its byte length before dispatch", async () => {
		const { server, transport, dispatch } = await fixture();
		const body = Buffer.from(
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "é".repeat(MAX_FRAME_BYTES / 2) } }),
		);
		expect(body.toString().length).toBeLessThan(MAX_FRAME_BYTES);
		const response = await sendBody(server, transport, body, 1);
		expect(response.status).toBe(413);
		expect(response.body).toMatchObject({ error: { message: "Body too large" } });
		expect(dispatch).not.toHaveBeenCalled();
	});
});
