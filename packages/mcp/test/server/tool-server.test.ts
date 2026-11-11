import { afterEach, describe, expect, it } from "vitest";
import { McpClient, StreamableHttpTransport } from "../../src/client/index.ts";
import { type ServedCall, type ServedTool, serveTools, type ToolServer } from "../../src/server/tool-server.ts";

const servers: ToolServer[] = [];
const clients: McpClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

const READ: ServedTool = {
	name: "read",
	description: "Read a file",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** A server whose calls the test answers by hand, and an MCP client connected to it with its token. */
async function connected(tools: ServedTool[] = [READ], headers?: Record<string, string>) {
	const calls: Array<ServedCall & { answer(text: string): void }> = [];
	let listed = tools;
	const server = await serveTools({
		name: "octocode",
		version: "1.0.0",
		tools: () => listed,
		call: (call) =>
			new Promise((resolve, reject) => {
				calls.push({ ...call, answer: (text) => resolve({ content: [{ type: "text", text }] }) });
				call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
			}),
	});
	servers.push(server);
	const client = new McpClient({ name: "scripted-client", version: "1.0.0" });
	clients.push(client);
	await client.connect(
		new StreamableHttpTransport({
			url: server.url,
			headers: headers ?? { ...server.headers },
			reconnect: { maxRetries: 0 },
		}),
	);
	return { server, client, calls, relist: (next: ServedTool[]) => (listed = next) };
}

const until = async (check: () => boolean) => {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(check()).toBe(true);
};

describe("the MCP tool server", () => {
	it("lists the host's tools and hands each call to the host, which answers it", async () => {
		const { client, calls } = await connected();
		expect((await client.listTools()).map((tool) => [tool.name, tool.description])).toEqual([["read", "Read a file"]]);
		const pending = client.callTool("read", { path: "src/app.ts" });
		await until(() => calls.length === 1);
		expect(calls[0]).toMatchObject({ name: "read", arguments: { path: "src/app.ts" } });
		calls[0].answer("export const answer = 42;");
		expect(await pending).toEqual({ content: [{ type: "text", text: "export const answer = 42;" }] });
	});

	it("answers an unknown tool and a failing host with an error result, never running anything", async () => {
		const server = await serveTools({
			name: "octocode",
			version: "1.0.0",
			tools: () => [READ],
			call: async () => {
				throw new Error("the gate refused it");
			},
		});
		servers.push(server);
		const client = new McpClient({ name: "scripted-client", version: "1.0.0" });
		clients.push(client);
		await client.connect(new StreamableHttpTransport({ url: server.url, headers: { ...server.headers } }));
		expect(await client.callTool("write", {})).toMatchObject({
			isError: true,
			content: [{ text: "Unknown tool: write" }],
		});
		expect(await client.callTool("read", { path: "x" })).toMatchObject({
			isError: true,
			content: [{ text: "the gate refused it" }],
		});
	});

	it("tells a connected client when the tool list changes", async () => {
		const { server, client, relist } = await connected();
		let changed = 0;
		client.onNotification("notifications/tools/list_changed", () => changed++);
		// The client opens its notification stream after the handshake; announce until it is there.
		relist([READ, { name: "write", inputSchema: { type: "object" } }]);
		await until(() => {
			server.toolsChanged();
			return changed > 0;
		});
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["read", "write"]);
	});

	it("aborts the host's call when the client cancels it", async () => {
		const { client, calls } = await connected();
		const controller = new AbortController();
		const pending = client.callTool("read", { path: "big" }, { signal: controller.signal });
		await until(() => calls.length === 1);
		controller.abort(new Error("user pressed Esc"));
		await expect(pending).rejects.toThrow();
		await until(() => calls[0].signal.aborted);
	});

	it("admits only its own token, on its own loopback host name, from no foreign web page", async () => {
		const { server } = await connected();
		const initialize = (headers: Record<string, string>) =>
			fetch(server.url, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
				}),
			});
		expect((await initialize({})).status).toBe(401);
		expect((await initialize({ authorization: "Bearer wrong" })).status).toBe(401);
		expect((await initialize({ ...server.headers, origin: "http://evil.example" })).status).toBe(403);
		const ok = await initialize({ ...server.headers });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			result: { protocolVersion: "2025-06-18", serverInfo: { name: "octocode" } },
		});
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	});

	it("ends calls in flight when it closes", async () => {
		const { server, client, calls } = await connected();
		const pending = client.callTool("read", { path: "x" });
		await until(() => calls.length === 1);
		await server.close();
		await until(() => calls[0].signal.aborted);
		await expect(pending).rejects.toThrow();
	});
});
