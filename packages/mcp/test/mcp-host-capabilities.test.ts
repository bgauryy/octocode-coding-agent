import { mcpHost } from "./mcp-host-fixture.ts";
import { connectionFixture } from "./mcp-connection-fixture.ts";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { getMcpSessionHandoff } from "../src/session-servers.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { createDefaultTransport, McpServerConnection } from "../src/runtime.ts";
import { McpFeatureState } from "../src/state.ts";

import { fakeHost } from "../../coding-agent/test/octocode/fake-host.ts";

const fixture = path.join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/resource-mcp.mjs");

describe("shared MCP host capabilities", () => {
	it("counts tool calls as active work before automatic skill-root restarts", async () => {
		const server = connectionFixture({
			launch: (cwd) => ({ command: process.execPath, args: [fixture], cwd, env: {} }),
			onTools: () => undefined,
		});
		try {
			await server.getClient();
			const reading = server.callTool("link", { slow: true }, {});
			await vi.waitFor(() => expect(server.idle).toBe(false));
			expect(await reading).toMatchObject({ content: [{ text: "TOOL_EVIDENCE" }] });
			expect(server.idle).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("does not expose resource support or stale tools after a catalog failure", async () => {
		const connection = new McpServerConnection({
			entry: { name: "docs", source: "test", config: { command: process.execPath, args: [fixture] } },
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => undefined,
		});
		try {
			await connection.callTool("link", { failList: true }, {});
			await vi.waitFor(() => expect(connection.error).toContain("catalog unavailable"));
			expect(connection.tools).toEqual([]);
			expect(connection).not.toHaveProperty("hasResources");
			expect(connection).not.toHaveProperty("readResource");
		} finally {
			await connection.close();
		}
	});
	it("lists a static resource without template support and reads a tool's link from the same server", async () => {
		const h = mcpHost({
			prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [fixture] } }),
		});
		try {
			await h.start();
			await h.prompt();
			for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
				expect(h.tools.has(name)).toBe(false);
			const link = await h.call("mcp__octocode__link", {});
			expect(link.content).toEqual([
				{ type: "text", text: expect.stringMatching(/^\[resource link \S+\]\nname: intro$/) },
			]);
			const uri = link.content[0].text.match(/^\[resource link (\S+)\]/)?.[1];
			expect((await h.call("mcp", { intent: "resources", server: "octocode" })).content[0].text).toContain(uri);
			expect((await h.call("mcp", { intent: "read", server: "octocode", uri })).content[0].text).toContain(
				"Resource evidence",
			);
			await h.call("mcp", { intent: "stop", server: "octocode" });
			expect(h.state.findServer("octocode")!.connection!.isStopped).toBe(true);
			await expect(h.call("mcp__octocode__link", {})).rejects.toThrow(/stopped|no longer available/);
			await h.call("mcp", { intent: "restart", server: "octocode" });
			expect((await h.call("mcp__octocode__link", { slow: true })).content[0].text).toBe("TOOL_EVIDENCE");
		} finally {
			await h.close();
		}
	});

	it("inherits extension registrations while omitting disabled, stopped and file-configured servers", async () => {
		const fake = fakeHost();
		Object.assign(fake.api, { channels: createEventBus() });
		const state = new McpFeatureState(fake.api, {});
		const config = { command: process.execPath, args: [fixture] };
		const stopped = new McpServerConnection({
			entry: { name: "stopped", source: "feature", scope: "feature", config },
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => undefined,
		});
		await stopped.stop();
		state.servers = [
			{ entry: { name: "plugin", source: "feature", scope: "feature", config } },
			{ entry: stopped.entry, connection: stopped },
			{ entry: { name: "disabled", source: "feature", scope: "feature", config: { ...config, enabled: false } } },
			{ entry: { name: "file", source: "mcp.json", scope: "global", config } },
		];
		registerMcpManageTool(state);
		// The stopped server is not handed over as an addition, but its name is, so children skip it too. `available` names
		// every enabled server of the session (what a task may name), the stopped and file-configured ones included.
		expect(getMcpSessionHandoff(fake.api.channels)).toEqual({
			servers: { plugin: config },
			stopped: [stopped.entry.name],
			available: ["plugin", "stopped", "file"],
			// The default `mcpExposure` (`recent`) hands the in-use set over, so the child defers the same tools.
			recent: [],
		});
		await stopped.close();
	});

	it("defers root changes during tool calls, applies them when idle, and leaves stopped servers stopped", async () => {
		let revision = "first";
		const h = mcpHost({
			prepareLaunch: (entry) => ({
				...entry,
				config: { ...entry.config, command: process.execPath, args: [fixture], env: { ROOT_REVISION: revision } },
			}),
		});
		try {
			await h.start();
			await h.prompt();
			const read = h.call("mcp__octocode__link", { slow: true });
			await vi.waitFor(() => expect(h.state.findServer("octocode")!.connection!.idle).toBe(false));
			revision = "second";
			await h.prompt();
			expect(h.transports).toHaveLength(1);
			expect((await read).content[0].text).toContain("TOOL_EVIDENCE");
			await h.prompt();
			expect(h.transports).toHaveLength(2);
			await h.call("mcp", { intent: "stop", server: "octocode" });
			revision = "third";
			await h.prompt();
			expect(h.transports).toHaveLength(2);
		} finally {
			await h.close();
		}
	});
});
