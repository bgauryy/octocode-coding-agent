import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { generatedDir } from "../src/compact/index.ts";
import { reconnect } from "../src/connections.ts";
import type { McpServerEntry } from "../src/config.ts";
import { DEFAULT_MCP_PRESENTATION, McpPresentation } from "../src/presentation/index.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * `declared` presentation (the default): each tool's declaration carries the server's own description and full input
 * JSON Schema, and the prompt's block holds the server's instructions only. Deferred tools keep their index lines.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];
const host = (servers?: McpServerEntry[], options: Parameters<typeof mcpHost>[0] = {}) => {
	const agentDir = tmp();
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	const result = mcpHost({
		...(servers ? { servers } : {}),
		prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [echo] } }),
		...options,
	});
	result.api.getActiveTools = () =>
		[...result.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	hosts.push(result);
	return { h: result, agentDir };
};
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const entry = (name: string, config: Partial<McpServerEntry["config"]> = {}): McpServerEntry => ({
	name,
	config: { command: "node", ...config } as McpServerEntry["config"],
	source: "test",
});
const declarations = (h: ReturnType<typeof mcpHost>) =>
	JSON.stringify(
		[...h.tools.values()]
			.filter((tool) => tool.name.startsWith("mcp__"))
			.map(({ name, description, parameters, exposure }) => ({ name, description, parameters, exposure })),
	);

describe("declared MCP presentation", () => {
	it("is the default", () => {
		expect(DEFAULT_MCP_PRESENTATION).toBe("declared");
	});

	it("declares each tool with the server's description and full input schema, and the block holds instructions only", async () => {
		const { h, agentDir } = host();
		await h.start();
		const { mcps } = await h.prompt();
		const server = h.state.findServer("octocode")!.connection!;
		expect(server.tools.length).toBeGreaterThan(1);
		for (const tool of server.tools) {
			const declared = h.tools.get(`mcp__octocode__${tool.name}`)!;
			expect(declared.description).toContain(tool.description?.trim() ?? "");
			// The schema is the server's own, key order included.
			expect(JSON.stringify(declared.parameters)).toBe(JSON.stringify(tool.inputSchema));
			expect(declared.validationParameters).toBeUndefined();
		}
		expect(mcps).toContain("Echo test server.");
		expect(mcps).toContain("Its tools are declared with their own descriptions and input schemas");
		for (const tool of server.tools) expect(mcps).not.toContain(tool.description!.trim());
		expect(mcps).not.toContain("Input schema");
		expect(mcps).not.toContain("declare namespace");
		// No generated file is written for a server nobody reads it for.
		expect(existsSync(join(generatedDir(agentDir), "octocode.json"))).toBe(false);
	});

	it("keeps deferred tools thin with an index line, and the rest of the server full", async () => {
		const { h } = host([entry("docs", { toolExposure: { shout: "deferred" } })], { exposure: "direct" });
		await h.start();
		const { mcps } = await h.prompt();
		// The declaration carries the server's whole description, so the index line is the name alone.
		expect(mcps).toContain("\n- shout\n");
		expect(mcps).not.toContain("- pick");
		const server = h.state.findServer("docs")!.connection!;
		const pick = server.tools.find((tool) => tool.name === "pick")!;
		expect(JSON.stringify(h.tools.get("mcp__docs__pick")!.parameters)).toBe(JSON.stringify(pick.inputSchema));
		const shout = h.tools.get("mcp__docs__shout")!;
		expect(shout.description).toBe("Uppercase the given text");
		expect(shout.validationParameters).toBeDefined();
	});

	it("keeps declarations and sections byte-identical across prompts and a reconnect", async () => {
		const { h } = host();
		await h.start();
		const first = await h.prompt();
		const before = declarations(h);
		const original = h.tools.get("mcp__octocode__shout");
		await h.prompt();
		await reconnect(h.state.findServer("octocode")!);
		const second = await h.prompt();
		expect(declarations(h)).toBe(before);
		expect(h.tools.get("mcp__octocode__shout")).toBe(original);
		expect(second.mcps).toBe(first.mcps);
	});

	it("describes only instructions: no tool is thin unless deferred, and a changed tool is not a changed block", () => {
		const presentation = new McpPresentation({ agentDir: () => tmp(), mode: () => "declared" });
		const tool = (name: string, description = "Does work.") => ({
			name,
			description,
			inputSchema: { type: "object" as const, properties: { b: { type: "string" }, a: { type: "number" } } },
		});
		const a = tool("a");
		presentation.sync("s", "s", "Be careful.", [a, tool("b")]);
		const described = presentation.describe("s", ["a", "b"], "Be careful.", true);
		expect(described.contract).toBe("Be careful.");
		expect(presentation.isThin("s", a)).toBe(false);
		expect(presentation.signature("s", "a")).toBeUndefined();
	});
});
