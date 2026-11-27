import { describe, expect, it } from "vitest";
import { StreamableHttpTransport } from "../../src/client/transports/streamable-http.ts";

describe("official MCP SSE transport", () => {
	it.each(["\n", "\r", "\r\n"])("handles %j separators at every byte split", async (newline) => {
		const text = [
			": heartbeat",
			"id: resume-1",
			"retry: 250",
			"event: message",
			'data: {"jsonrpc":"2.0","id":1,"result":',
			'data: {"message":"שלום"}}',
			"",
			"",
		].join(newline);
		const bytes = new TextEncoder().encode(text);
		for (let split = 0; split <= bytes.length; split++) {
			const transport = new StreamableHttpTransport({
				url: "https://fixture.example/mcp",
				openGetStream: false,
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(bytes.subarray(0, split));
								controller.enqueue(bytes.subarray(split));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			});
			const answer = new Promise((resolve) => transport.onMessage(resolve));
			await transport.start();
			await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
			expect(await answer).toEqual({ jsonrpc: "2.0", id: 1, result: { message: "שלום" } });
			await transport.close();
		}
	});

	it("resumes a primed response with its event ID even when the standalone GET stream is disabled", async () => {
		const requests: RequestInit[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://fixture.example/mcp",
			openGetStream: false,
			fetch: async (_url, init) => {
				requests.push(init!);
				return new Response(
					init?.method === "GET"
						? 'data: {"jsonrpc":"2.0","id":1,"result":{"resumed":true}}\n\n'
						: "id: resume-1\nretry: 1\ndata:\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const answer = new Promise((resolve) => transport.onMessage(resolve));
		await transport.start();
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(await answer).toEqual({ jsonrpc: "2.0", id: 1, result: { resumed: true } });
		expect(requests).toHaveLength(2);
		expect(new Headers(requests[1].headers).get("last-event-id")).toBe("resume-1");
		await transport.close();
	});
});
