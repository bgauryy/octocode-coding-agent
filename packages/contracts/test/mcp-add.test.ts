import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AttachToolStatesSchema } from "../src/daemon.ts";
import { McpAddCommandSchema, McpAddResultSchema, McpAddAvailabilitySchema } from "../src/config.ts";

describe("MCP add wire contract", () => {
	it("carries optional complete registry names without changing legacy tool snapshots", () => {
		const snapshot = { native: { names: [], deferred: {} }, mcp: [] };
		expect(Value.Check(AttachToolStatesSchema, snapshot)).toBe(true);
		expect(Value.Check(AttachToolStatesSchema, { ...snapshot, mcpServerNames: [] })).toBe(true);
		expect(Value.Check(AttachToolStatesSchema, { ...snapshot, mcpServerNames: ["disabled-ext"] })).toBe(true);
		expect(
			Value.Check(AttachToolStatesSchema, { ...snapshot, mcpServerNames: [{ name: "ext", env: { TOKEN: "secret" } }] }),
		).toBe(false);
	});
	it("returns only availability, never registry names", () => {
		expect(Value.Check(McpAddAvailabilitySchema, { available: true })).toBe(true);
		expect(Value.Check(McpAddAvailabilitySchema, { available: false, message: "Open a running session" })).toBe(true);
		expect(Value.Check(McpAddAvailabilitySchema, { available: true, mcpServerNames: ["private-name"] })).toBe(false);
	});
	it.each([
		{ name: "local", scope: "global", transport: "stdio", command: "node", args: ["a b"], env: { TOKEN: "secret" } },
		{
			name: "remote",
			scope: "workspace",
			repoId: "repo",
			transport: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "secret" },
		},
	])("accepts one transport definition", (command) => expect(Value.Check(McpAddCommandSchema, command)).toBe(true));
	it.each([
		{ name: "", scope: "global", transport: "stdio", command: "node" },
		{ name: "bad name", scope: "global", transport: "stdio", command: "node" },
		{ name: "local", scope: "global", transport: "stdio", command: "node", enabled: true },
		{ name: "local", scope: "global", transport: "stdio", command: "node", args: "--port 3" },
		{ name: "remote", scope: "global", transport: "http", url: "https://example.test", env: {} },
	])("rejects malformed or extra fields", (command) => expect(Value.Check(McpAddCommandSchema, command)).toBe(false));
	it("allows only a status message in the save response", () => {
		expect(Value.Check(McpAddResultSchema, { saved: true, message: "Saved" })).toBe(true);
		expect(
			Value.Check(McpAddResultSchema, { saved: true, message: "Saved", warnings: ["Audit recording unavailable"] }),
		).toBe(true);
		expect(Value.Check(McpAddResultSchema, { saved: true, message: "Saved", warnings: [123] })).toBe(false);
		expect(Value.Check(McpAddResultSchema, { saved: true, message: "Saved", env: { TOKEN: "secret" } })).toBe(false);
	});
});
