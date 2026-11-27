import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, StreamableHttpTransport, type McpFetch, type JsonRpcRequest } from "../../src/client/index.ts";

const clients: McpClient[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
const json = (id: string | number, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
async function connect(
	handler: McpFetch,
	options: Partial<ConstructorParameters<typeof StreamableHttpTransport>[0]> = {},
) {
	const transport = new StreamableHttpTransport({
		url: "https://fixture.example/mcp",
		openGetStream: false,
		...options,
		fetch: async (input, init) => {
			if (new URL(String(input)).hostname !== "fixture.example") return handler(input, init);
			if (init?.method === "DELETE") return handler(input, init);
			const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
			if (request.method === "initialize")
				return Response.json(
					{
						jsonrpc: "2.0",
						id: request.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "fixture", version: "1" },
						},
					},
					{ headers: { "mcp-session-id": "session-1" } },
				);
			if (!("id" in request)) return new Response(null, { status: 202 });
			return handler(input, init);
		},
	});
	const client = new McpClient({ name: "test", version: "1" });
	clients.push(client);
	await client.connect(transport);
	return client;
}

describe("SDK HTTP host policy", () => {
	it("releases caller abort listeners after standalone SSE responses and close", async () => {
		const signal = new AbortController().signal;
		const transport = new StreamableHttpTransport({
			url: "https://fixture.example/mcp",
			openGetStream: false,
			fetch: async (_input, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		await transport.start();
		for (let id = 0; id < 3; id++) {
			let dispose = () => {};
			const answered = new Promise<void>((resolve) => {
				dispose = transport.onMessage(() => resolve());
			});
			await transport.send({ jsonrpc: "2.0", id, method: "ping" }, { signal });
			await answered;
			dispose();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
		}
		await transport.close();
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
	});

	it("keeps MCP headers out of cross-origin OAuth requests and accepts the issuer response", async () => {
		let token = "old";
		const issuerHeaders: Headers[] = [];
		const client = await connect(
			async (input, init) => {
				if (String(input) === "https://issuer.example/token") {
					issuerHeaders.push(new Headers(init?.headers));
					const response = Response.json({ access_token: "new" });
					Object.defineProperty(response, "url", { value: String(input) });
					return response;
				}
				if (init?.method === "DELETE") return new Response(null, { status: 200 });
				if (new Headers(init?.headers).get("authorization") === "Bearer old")
					return new Response(null, { status: 401 });
				return json((JSON.parse(String(init?.body)) as JsonRpcRequest).id, { tools: [] });
			},
			{
				headers: { "x-mcp-secret": "private" },
				authProvider: {
					token: async () => token,
					onUnauthorized: async (context) => {
						const response = await context.fetch("https://issuer.example/token", {
							method: "POST",
							headers: { "content-type": "application/x-www-form-urlencoded" },
							body: "grant_type=refresh_token",
						});
						token = ((await response.json()) as { access_token: string }).access_token;
					},
				},
			},
		);
		expect(await client.listTools()).toEqual([]);
		expect(issuerHeaders).toHaveLength(1);
		expect(issuerHeaders[0].get("x-mcp-secret")).toBeNull();
		expect(issuerHeaders[0].get("authorization")).toBeNull();
	});

	it("fails only a broken response stream and keeps concurrent requests alive", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = await connect(async (_input, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 200 });
			const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
			if ((request.params as { name: string }).name === "broken")
				return new Response("data: not json\n\n", { headers: { "content-type": "text/event-stream" } });
			await gate;
			return json(request.id, { content: [{ type: "text", text: "kept" }] });
		});
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		const kept = client.callTool("kept");
		await expect(client.callTool("broken")).rejects.toThrow("MCP response stream failed");
		release();
		expect(await kept).toEqual({ content: [{ type: "text", text: "kept" }] });
		expect(errors).toHaveLength(1);
	});

	it.each(["application/json", "text/event-stream"])(
		"bounds and cancels an endless %s response",
		async (contentType) => {
			let cancelled = false;
			let sent = 0;
			const client = await connect(
				async (_input, init) => {
					if (init?.method === "DELETE") return new Response(null, { status: 200 });
					return new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								sent++;
								controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(100) + "\n"));
							},
							cancel() {
								cancelled = true;
							},
						}),
						{ headers: { "content-type": contentType } },
					);
				},
				{ maxMessageBytes: 512 },
			);
			await expect(client.listTools()).rejects.toThrow(
				contentType === "application/json" ? "exceeds 512" : "MCP response stream failed",
			);
			expect(cancelled).toBe(true);
			expect(sent).toBeLessThan(10);
		},
	);

	it("cancels a stalled SSE reader when its request is cancelled", async () => {
		let cancelled = false;
		let started!: () => void;
		const arrived = new Promise<void>((resolve) => {
			started = resolve;
		});
		const client = await connect(async (_input, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 200 });
			started();
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		const controller = new AbortController();
		const request = client.callTool("wait", {}, { signal: controller.signal });
		const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
		await arrived;
		controller.abort();
		await rejected;
		await vi.waitFor(() => expect(cancelled).toBe(true));
	});

	it("recovers 401 and scope challenges using the rejected token", async () => {
		let token = "old";
		const seen: { status: number; token?: string }[] = [];
		const client = await connect(
			async (_input, init) => {
				if (init?.method === "DELETE") return new Response(null, { status: 200 });
				const bearer = new Headers(init?.headers).get("authorization");
				if (bearer === "Bearer old")
					return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
				if (bearer === "Bearer new")
					return new Response(null, {
						status: 403,
						headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' },
					});
				return json((JSON.parse(String(init?.body)) as JsonRpcRequest).id, { content: [] });
			},
			{
				authProvider: {
					token: async () => token,
					onUnauthorized: async (context) => {
						seen.push({ status: context.response.status, token: context.token });
						token = context.response.status === 401 ? "new" : "admin";
					},
				},
			},
		);
		expect(await client.callTool("echo")).toEqual({ content: [] });
		expect(seen).toEqual([
			{ status: 401, token: "old" },
			{ status: 403, token: "new" },
		]);
	});

	it("classifies repeated authentication failure", async () => {
		const client = await connect(
			async (_input, init) =>
				init?.method === "DELETE"
					? new Response(null, { status: 200 })
					: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
			{ authProvider: { token: async () => "rejected", onUnauthorized: async () => {} } },
		);
		await expect(client.listTools()).rejects.toMatchObject({ name: "McpAuthRequiredError", status: 401 });
	});

	it("does not replay a cancelled request after refresh finishes", async () => {
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const client = await connect(
			async (_input, init) => {
				if (init?.method === "DELETE") return new Response(null, { status: 200 });
				calls++;
				return new Response(null, { status: 401 });
			},
			{
				authProvider: {
					token: async () => "old",
					onUnauthorized: async () => {
						entered();
						await gate;
					},
				},
			},
		);
		const controller = new AbortController();
		const request = client.listTools({ signal: controller.signal });
		const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
		await started;
		controller.abort();
		await rejected;
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
	});

	it("finishes shutdown when DELETE ignores cancellation, without refreshing credentials", async () => {
		let tokenCalls = 0;
		const client = await connect(async () => new Promise<Response>(() => {}), {
			authProvider: { token: async () => `token-${++tokenCalls}` },
		});
		const before = tokenCalls;
		await client.close();
		expect(tokenCalls).toBe(before);
		expect(client.connectionState).toBe("closed");
	});

	it("rejects accepted requests without responses", async () => {
		const client = await connect(async () => new Response(null, { status: 202 }));
		await expect(client.listTools()).rejects.toThrow("without a response");
	});
});
import { getEventListeners } from "node:events";
