import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, type JsonRpcRequest } from "../../src/client/index.ts";
import { createInMemoryTransportPair } from "../../src/client/testing/index.ts";

afterEach(() => vi.useRealTimers());
async function fixture(options: ConstructorParameters<typeof McpClient>[0] = { name: "test", version: "1" }) {
	const pair = createInMemoryTransportPair();
	const client = new McpClient(options);
	const sent: JsonRpcRequest[] = [];
	pair.server.onMessage((message) => {
		if (!("method" in message) || !("id" in message)) return;
		if (message.method === "initialize") {
			void pair.server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "test", version: "1" },
				},
			});
		} else sent.push(message);
	});
	await pair.server.start();
	await client.connect(pair.client);
	return { client, server: pair.server, sent };
}

describe("SDK request lifetime compatibility", () => {
	it.each([0, Infinity, -1, NaN])("does not turn idle setting %s into an immediate timeout", async (timeoutMs) => {
		vi.useFakeTimers();
		const { client } = await fixture();
		const controller = new AbortController();
		const request = client.callTool("wait", {}, { timeoutMs, signal: controller.signal });
		let settled = false;
		void request
			.finally(() => {
				settled = true;
			})
			.catch(() => {});
		const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settled).toBe(false);
		controller.abort();
		await rejected;
		await client.close();
	});

	it("caps initialization even when the idle timeout is longer", async () => {
		vi.useFakeTimers();
		const pair = createInMemoryTransportPair();
		await pair.server.start();
		const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 1000, maxTotalTimeoutMs: 20 });
		const connected = client.connect(pair.client);
		const rejected = expect(connected).rejects.toMatchObject({ name: "McpTimeoutError", timeoutMs: 20 });
		await vi.advanceTimersByTimeAsync(21);
		await rejected;
		expect(client.connectionState).toBe("closed");
	});

	it("isolates progress and error observer failures from request completion", async () => {
		const { client, server, sent } = await fixture();
		const observed: string[] = [];
		client.onError(() => {
			throw new Error("observer failed");
		});
		client.onError((error) => observed.push(error.message));
		const result = client.callTool(
			"wait",
			{},
			{
				onProgress: () => {
					throw new Error("progress failed");
				},
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const request = sent[0];
		const token = (request.params as { _meta: { progressToken: number } })._meta.progressToken;
		await server.send({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: token, progress: 1 },
		});
		await server.send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
		expect(await result).toEqual({ content: [] });
		expect(observed).toEqual(["progress failed"]);
		await client.close();
	});
});
