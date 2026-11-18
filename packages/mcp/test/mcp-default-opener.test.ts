import { describe, expect, it, vi } from "vitest";
import { fakeHost } from "../../coding-agent/test/octocode/fake-host.ts";
import { login } from "../src/cli/login.ts";
import type { McpServerEntry } from "../src/config.ts";
import type { McpOAuthCredentialStore } from "../src/oauth.ts";
import type { McpServerConnection } from "../src/runtime.ts";

// The system opener is the external boundary: here it fails the way a missing `xdg-open` does.
const opener = vi.hoisted(() => ({ openTarget: vi.fn(async (_target: string) => undefined) }));
vi.mock("../../common/src/open-target.ts", () => opener);
vi.mock("../src/oauth.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	signInMcpServer: async (options: { prompt: { showAuthorizationUrl(url: URL): void } }) =>
		options.prompt.showAuthorizationUrl(new URL("https://auth.example.com/authorize?a=1&b=2")),
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the default MCP sign-in opener", () => {
	it("opens the authorization URL with the system opener and keeps a launch failure from escaping", async () => {
		// The setup file loaded state.ts before this file's mocks registered: load a fresh graph that sees them.
		vi.resetModules();
		await import("../../coding-agent/test/mcp-host.ts");
		expect(vi.isMockFunction((await import("../../common/src/open-target.ts")).openTarget)).toBe(true);
		const { McpFeatureState } = await import("../src/state.ts");
		opener.openTarget.mockRejectedValueOnce(new Error("spawn xdg-open ENOENT"));
		const state = new McpFeatureState(fakeHost().api, {});
		expect(() => state.openUrl("https://auth.example.com/authorize?a=1&b=2")).not.toThrow();
		await tick();
		expect(opener.openTarget).toHaveBeenLastCalledWith("https://auth.example.com/authorize?a=1&b=2");
	});

	it("`octocode mcp login` prints the link, then says the browser could not open, and still finishes the sign-in", async () => {
		opener.openTarget.mockRejectedValueOnce(new Error("spawn xdg-open ENOENT"));
		const connection = {
			state: "needs-auth",
			tools: [],
			challenge: undefined,
			getClient: async () => {
				throw new Error("unauthorized");
			},
			oauthSettings: () => ({}),
			reconnect: async () => undefined,
		} as unknown as McpServerConnection;
		const credentials = { forServer: () => ({}) } as unknown as McpOAuthCredentialStore;
		const entry = { name: "docs", config: { url: "https://mcp.example.com" }, source: "test" } as McpServerEntry;
		const logs: string[] = [];
		const errors: string[] = [];
		const code = await login(
			entry,
			connection,
			"https://mcp.example.com",
			1_000,
			{ cwd: "/workspace", agentDir: "/agent" },
			credentials,
			(line) => logs.push(line),
			(line) => errors.push(line),
		);
		await tick();
		expect(code).toBe(0);
		expect(logs[0]).toContain("https://auth.example.com/authorize?a=1&b=2");
		expect(opener.openTarget).toHaveBeenLastCalledWith("https://auth.example.com/authorize?a=1&b=2");
		expect(errors).toEqual(["Could not open a browser (spawn xdg-open ENOENT); open the link above."]);
	});
});
