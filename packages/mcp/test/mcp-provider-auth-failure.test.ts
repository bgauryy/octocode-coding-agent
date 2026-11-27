import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { createDefaultTransport, McpServerConnection } from "../src/runtime.ts";

describe("provider token failure", () => {
	it("ends in a visible failed state naming the provider failure, and sends no unauthenticated request", async () => {
		const requests: (string | undefined)[] = [];
		const server = createServer((request, response) => {
			requests.push(request.headers.authorization);
			request.resume();
			response.writeHead(401).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const connection = new McpServerConnection({
			entry: {
				name: "gateway",
				config: { url: `http://127.0.0.1:${port}/mcp`, auth: { provider: "gateway" } },
				source: "test",
			},
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			providerToken: async () => {
				throw new Error('API key auth failed for provider gateway: key command "!op read" failed');
			},
			onTools: () => {},
		});
		try {
			await expect(connection.getClient()).rejects.toThrow(/gateway.*API key auth failed for provider gateway/s);
			expect(connection.state).toBe("failed");
			expect(connection.error).toContain("API key auth failed for provider gateway");
			expect(requests).toEqual([]);
		} finally {
			await connection.close();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
