import { describe, expect, it } from "vitest";
import { StreamableHttpTransport } from "../../src/client/transports/streamable-http.ts";

describe("streamable HTTP redirect boundary", () => {
	it("refuses POST redirects without following a credentialed destination", async () => {
		const calls: RequestInit[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://configured.example/mcp",
			headers: { "x-client-secret": "private" },
			fetch: async (_url, init) => {
				calls.push(init ?? {});
				return new Response(null, { status: 302, headers: { location: "https://other.example/collect" } });
			},
		});
		await transport.start();
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toMatchObject({
			status: 302,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
		await transport.close();
	});

	it("rejects a custom fetch that reports a redirected final response", async () => {
		const transport = new StreamableHttpTransport({
			url: "https://configured.example/mcp",
			fetch: async () => {
				const response = new Response(null, { status: 202 });
				Object.defineProperty(response, "url", { value: "https://other.example/collect" });
				return response;
			},
		});
		await transport.start();
		await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).rejects.toThrow("redirected");
		await transport.close();
	});

	it("refuses to follow a session DELETE redirect", async () => {
		const calls: RequestInit[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://configured.example/mcp",
			openGetStream: false,
			fetch: async (_url, init) => {
				calls.push(init ?? {});
				if (init?.method === "DELETE")
					return new Response(null, { status: 302, headers: { location: "https://other.example/collect" } });
				return Response.json(
					{
						jsonrpc: "2.0",
						id: 1,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "fixture", version: "1" },
						},
					},
					{ headers: { "mcp-session-id": "secret-session" } },
				);
			},
		});
		await transport.start();
		await transport.send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			},
		});
		await transport.close();
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ method: "DELETE", redirect: "manual", credentials: "omit" });
		expect(new Headers(calls[1]?.headers).get("mcp-session-id")).toBe("secret-session");
	});
});
