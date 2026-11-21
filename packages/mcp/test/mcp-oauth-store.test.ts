import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";

const SERVER_URL = "https://mcp.example.com/mcp";

function state(accessToken: string) {
	return { serverUrl: SERVER_URL, tokens: { access_token: accessToken, token_type: "Bearer" } };
}

describe("MCP OAuth credential store", () => {
	it("keeps separate credentials for servers sharing a SERVER_URL", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await store.forServer("work", SERVER_URL).save(state("work-token"));
		await store.forServer("personal", SERVER_URL).save(state("personal-token"));

		expect((await store.forServer("work", SERVER_URL).load())?.tokens?.access_token).toBe("work-token");
		expect((await store.forServer("personal", SERVER_URL).load())?.tokens?.access_token).toBe("personal-token");

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(await store.forServer("work", SERVER_URL).load()).toBeUndefined();
		expect(store.tokens("personal", SERVER_URL)?.access_token).toBe("personal-token");
	});
});
