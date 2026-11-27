import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { generatedDir, readGenerated, renderServer } from "../src/compact/index.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { firstSentence } from "../src/presentation/declaration.ts";
import { reconnect, startConnection } from "../src/connections.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];
const host = (options: Parameters<typeof mcpHost>[0] = {}) => {
	const result = mcpHost({
		prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [echo] } }),
		presentation: "compact",
		...options,
	});
	hosts.push(result);
	return result;
};
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

function isolatedAgentDir(): string {
	const agentDir = tmp();
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	return agentDir;
}

const call = (name: string, args: Record<string, unknown>) => ({
	type: "toolCall" as const,
	id: "c1",
	name,
	arguments: args as never,
});

describe("compact MCP presentation", () => {
	it("generates the server file on connect, once per catalog hash", async () => {
		const dir = generatedDir(isolatedAgentDir());
		const h = host();
		await h.start();
		await h.prompt();
		const first = readGenerated(dir, "octocode");
		expect(first?.text).toContain("declare namespace octocode {");
		expect(first?.text).toContain("function shout(input: ");
		expect(first?.text).toContain("declare namespace octocode");
		await reconnect(h.state.findServer("octocode")!);
		await h.prompt();
		expect(readGenerated(dir, "octocode")?.meta.generatedAt).toBe(first?.meta.generatedAt);
		expect(readGenerated(dir, "octocode")?.meta.hash).toBe(first?.meta.hash);
	});

	it("regenerates on tools/list_changed and instructions change but applies the new file only at a loadout rebuild", async () => {
		const dir = generatedDir(isolatedAgentDir());
		const h = host();
		await h.start();
		const before = await h.prompt();
		const hash = readGenerated(dir, "octocode")!.meta.hash;
		await h.call("mcp__octocode__grow");
		await vi.waitFor(() => expect(readGenerated(dir, "octocode")?.text).toContain("function late("));
		expect(readGenerated(dir, "octocode")!.meta.hash).not.toBe(hash);
		const during = await h.prompt();
		// The file's section is byte-identical; the new tool, which the frozen file does not describe, is declared in full.
		expect(during.mcps).toBe(before.mcps);
		expect(during.mcps).not.toContain("function late(");
		expect(h.tools.get("mcp__octocode__late").validationParameters).toBeUndefined();
		await h.fire("model_select", { model: undefined }, h.ctx);
		expect((await h.prompt()).mcps).toContain("function late(");
	});

	it("declares thin stubs, validates against the server's schema and teaches with the signature", async () => {
		isolatedAgentDir();
		const h = host();
		await h.start();
		await h.prompt();
		const shout = h.tools.get("mcp__octocode__shout");
		// Top-level field types and required fields: without the types models send arrays and objects as JSON strings (S4 eval).
		expect(shout.parameters).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			additionalProperties: true,
			required: ["text"],
		});
		expect(shout.description).toBe("Uppercase the given text");
		expect(shout.validationParameters).toMatchObject({ properties: { text: { type: "string" } }, required: ["text"] });
		expect(validateToolArguments(shout, call(shout.name, { text: "hi" }))).toEqual({ text: "hi" });
		expect(() => validateToolArguments(shout, call(shout.name, {}))).toThrow(/text/);
		expect(() => validateToolArguments(shout, call(shout.name, {}))).toThrow(/function shout\(input: \{/);
		// A call that passes validation still reaches the server.
		expect(await h.call(shout.name, { text: "hi" })).toMatchObject({ content: [{ text: "HI" }] });
	});

	it("shows the file instead of the raw instructions and tool names", async () => {
		isolatedAgentDir();
		const h = host();
		await h.start();
		const sections = await h.prompt();
		const contract = sections.mcps;
		expect(contract).toContain("declare namespace octocode {");
		expect(contract).toContain("function shout(");
		expect(contract).toContain('tools="mcp__octocode__*"');
		// Every server is connected: no status section, and no other MCP section.
		expect(Object.keys(sections).filter((name) => name.startsWith("mcp"))).toEqual(["mcps"]);
		expect(contract).toContain('<mcp name="octocode" tools="mcp__octocode__*">');
		expect(contract).not.toContain("state=");
	});

	it("describes tools in plain form, declares them thin and writes nothing when mcpPresentation is json", async () => {
		const dir = generatedDir(isolatedAgentDir());
		const h = host({ presentation: "json" });
		await h.start();
		const { mcps: section } = await h.prompt();
		const shout = h.tools.get("mcp__octocode__shout");
		// The section holds the description and the server's JSON Schema; the declaration is not a second copy.
		expect(section).toContain("// mcp__octocode__shout\nUppercase the given text\nInput schema (JSON Schema): {");
		expect(section).toContain('"required":["text"]');
		expect(section).not.toContain("declare namespace");
		expect(shout.parameters).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			additionalProperties: true,
			required: ["text"],
		});
		expect(shout.validationParameters).toMatchObject({ properties: { text: { type: "string" } }, required: ["text"] });
		expect(existsSync(join(dir, "octocode.txt"))).toBe(false);
	});

	it("reads mcpPresentation from the settings", async () => {
		isolatedAgentDir();
		const h = host({ presentation: undefined });
		h.api.settings.get = () => ({ mcpPresentation: "json" }) as never;
		await h.start();
		expect((await h.prompt()).mcps).toContain("Input schema (JSON Schema): {");
	});

	it("regenerates when a tool is hidden by configuration", async () => {
		const dir = generatedDir(isolatedAgentDir());
		const h = host();
		await h.start();
		await h.prompt();
		expect(readFileSync(join(dir, "octocode.txt"), "utf8")).toContain("function fail(");
		const entry = h.state.findServer("octocode")!.entry;
		entry.config = { ...entry.config, toolExposure: { fail: "hidden" } };
		await h.prompt();
		expect(readFileSync(join(dir, "octocode.txt"), "utf8")).not.toContain("function fail(");
	});
});

describe("McpPresentation", () => {
	const tool = (name: string, description = "Does work.") => ({
		name,
		description,
		inputSchema: { type: "object" as const, properties: { id: { type: "string" } } },
	});

	it("renders no file in json mode and survives an unwritable store", () => {
		const off = new McpPresentation({ agentDir: tmp, mode: () => "json" });
		off.sync("s", "s", undefined, [tool("a")]);
		expect(off.isThin("s", tool("a"))).toBe(false);
		const described = off.describe("s", ["a"], "Be careful.", true);
		expect(described.file).toBeUndefined();
		expect(described.contract).toBe(
			[
				'// MCP server "s" \u00b7 call a tool by the name on its // line, with the input object.',
				"Be careful.",
				"// mcp__s__a",
				"Does work.",
				'Input schema (JSON Schema): {"type":"object","properties":{"id":{"type":"string"}}}',
			].join("\n"),
		);
		expect(off.isThin("s", tool("a"))).toBe(true);
		const blocked = new McpPresentation({ agentDir: () => "/dev/null/x", mode: () => "compact" });
		const a = tool("a");
		blocked.sync("s", "s", undefined, [a]);
		expect(blocked.isThin("s", a)).toBe(false);
		blocked.describe("s", ["a"], undefined, true);
		expect(blocked.isThin("s", a)).toBe(true);
		expect(blocked.signature("s", "a")).toContain("function a(");
	});

	it("keeps the prompt copy through reconnects, new and withdrawn tools, and renews it when the contract changes", () => {
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		const a = tool("a");
		presentation.sync("s", "s", "Be careful.", [a]);
		const describe = (tools: string[], instructions = "Be careful.") =>
			presentation.describe("s", tools, instructions, true);
		const frozen = describe(["a"]).file;
		expect(frozen).toContain("Be careful.");
		// A new tool is declared in full; the block stays.
		presentation.sync("s", "s", "Be careful.", [a, tool("b")]);
		expect(describe(["a", "b"]).file).toBe(frozen);
		expect(presentation.isThin("s", a)).toBe(true);
		expect(presentation.isThin("s", tool("b"))).toBe(false);
		expect(presentation.signature("s", "b")).toContain("function b(");
		// A dropped connection withdraws the catalog; the description stays.
		presentation.sync("s", "s", undefined, []);
		expect(describe([]).file).toBe(frozen);
		// A reconnect with an equal catalog (new objects, a new latest file) and a withdrawn tool keep it too.
		presentation.sync("s", "s", "Be careful.", [tool("a"), tool("b")]);
		expect(describe(["a", "b"]).file).toBe(frozen);
		presentation.sync("s", "s", "Be careful.", [tool("b")]);
		expect(describe(["b"]).file).toBe(frozen);
		// A changed description renews the copy, with the tools declared now; the changed tool is thin again.
		const changed = tool("a", "Does other work.");
		presentation.sync("s", "s", "Be careful.", [changed, tool("b")]);
		const renewed = describe(["a", "b"]).file;
		expect(renewed).toContain("Does other work.");
		expect(renewed).toContain("function b(");
		expect(presentation.isThin("s", changed)).toBe(true);
		expect(presentation.isThin("s", a)).toBe(false);
		expect(describe(["a", "b"]).file).toBe(renewed);
		// So do changed instructions, a changed input schema and a changed output schema.
		presentation.sync("s", "s", "Be very careful.", [changed, tool("b")]);
		expect(describe(["a", "b"], "Be very careful.").file).toContain("Be very careful.");
		const schema = { ...changed, inputSchema: { type: "object" as const, properties: { id: { type: "number" } } } };
		presentation.sync("s", "s", "Be very careful.", [schema, tool("b")]);
		expect(describe(["a", "b"], "Be very careful.").file).toMatch(/id\?: number/);
		expect(presentation.isThin("s", schema)).toBe(true);
		const output = { ...schema, outputSchema: { type: "object" as const, properties: { hits: { type: "number" } } } };
		presentation.sync("s", "s", "Be very careful.", [output, tool("b")]);
		describe(["a", "b"], "Be very careful.");
		expect(presentation.isThin("s", output)).toBe(true);
		expect(presentation.isThin("s", schema)).toBe(false);
		presentation.rebuild();
		expect(describe(["a"], "Be very careful.").file).toContain("Does other work.");
		expect(presentation.isThin("s", output)).toBe(true);
	});

	it("keeps a tool thin when only fields outside its contract change, and counts a title that stands in for the description", () => {
		for (const mode of ["compact", "json"] as const) {
			const presentation = new McpPresentation({ agentDir: tmp, mode: () => mode });
			presentation.sync("s", "s", undefined, [tool("a"), { ...tool("b", ""), title: "Old title" }]);
			const block = presentation.describe("s", ["a", "b"], undefined, true).contract;
			const retitled = { ...tool("a"), title: "Work", execution: { taskSupport: "optional" as const } };
			presentation.sync("s", "s", undefined, [retitled, { ...tool("b", ""), title: "Old title" }]);
			expect(presentation.describe("s", ["a", "b"], undefined, true).contract).toBe(block);
			expect(presentation.isThin("s", retitled)).toBe(true);
			// Without a description the plain form shows the title, so a new title is a new contract.
			const b = { ...tool("b", ""), title: "New title" };
			presentation.sync("s", "s", undefined, [retitled, b]);
			const renewed = presentation.describe("s", ["a", "b"], undefined, true).contract;
			if (mode === "json") expect(renewed).toContain("New title");
			else expect(renewed).toBe(block);
			expect(presentation.isThin("s", b)).toBe(true);
		}
	});

	it("describes a server first seen without its catalog once more when it connects, then keeps it until the contract changes", () => {
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		expect(presentation.describe("s", [], undefined, false).file).toBeUndefined();
		presentation.sync("s", "s", undefined, [tool("a")]);
		const connected = presentation.describe("s", ["a"], undefined, true).file;
		expect(connected).toContain("function a(");
		presentation.sync("s", "s", undefined, [tool("a")]);
		expect(presentation.describe("s", ["a"], undefined, true).file).toBe(connected);
		// While the server is not connected the copy stays, even with a changed catalog.
		presentation.sync("s", "s", undefined, [tool("a", "Changed.")]);
		expect(presentation.describe("s", ["a"], undefined, false).file).toBe(connected);
		expect(presentation.describe("s", ["a"], undefined, true).file).toContain("Changed.");
	});

	it("reuses a stored file whose hash matches and renders again for a changed catalog", () => {
		const agentDir = tmp();
		const presentation = () => new McpPresentation({ agentDir: () => agentDir, mode: () => "compact" });
		presentation().sync("s", "s", undefined, [tool("a")]);
		const first = readGenerated(generatedDir(agentDir), "s")!;
		presentation().sync("s", "s", undefined, [tool("a")]);
		expect(readGenerated(generatedDir(agentDir), "s")!.meta.generatedAt).toBe(first.meta.generatedAt);
		presentation().sync("s", "s", undefined, [tool("a", "Changed.")]);
		const next = readGenerated(generatedDir(agentDir), "s")!;
		expect(next.meta.hash).not.toBe(first.meta.hash);
		expect(next.text).toContain("Changed.");
	});

	it("renders the server's own text", () => {
		const agentDir = tmp();
		new McpPresentation({ agentDir: () => agentDir, mode: () => "compact" }).sync("s", "s", undefined, [tool("a")]);
		const stored = readGenerated(generatedDir(agentDir), "s")!;
		expect(stored.text).toBe(renderServer({ server: "s", tools: [tool("a")] }));
		expect(stored.text).toContain("/** Does work. */");
	});
});

describe("firstSentence", () => {
	it("keeps the whole first sentence on one line", () => {
		expect(firstSentence("Find text.\nMore detail follows.")).toBe("Find text.");
		expect(firstSentence("No period here")).toBe("No period here");
		expect(firstSentence("<when>Find text, or counts.</when><workflow>Then read.</workflow>")).toBe(
			"Find text, or counts.",
		);
		expect(firstSentence("a ".repeat(300))).toBe("a ".repeat(300).trim());
		expect(firstSentence("Reads v1.2 files. Then more.")).toBe("Reads v1.2 files.");
	});
});

describe("servers outside the tool selection", () => {
	it("are not started, and a server started by hand anyway gets its tools activated", async () => {
		isolatedAgentDir();
		const h = host({
			servers: [{ name: "octocode", config: { command: "unused", defaultActive: false }, source: "test" }],
		});
		h.api.tools.selects = (_prefix: string, activeByDefault: boolean) => activeByDefault;
		await h.start();
		const server = h.state.findServer("octocode")!;
		expect(server.unselected).toBe(true);
		expect(h.transports).toHaveLength(0);
		await startConnection(h.state, server);
		expect(server.unselected).toBeUndefined();
		expect(h.tools.get("mcp__octocode__shout").defaultActive).toBeUndefined();
	});
});
