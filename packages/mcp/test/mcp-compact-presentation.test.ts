import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import {
	catalogHashes,
	COMPACT_GENERATOR_VERSION,
	generatedDir,
	readGenerated,
	renderServer,
	writeGenerated,
} from "../src/compact/index.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { firstSentence } from "../src/presentation/declaration.ts";
import { reconnect, startConnection } from "../src/connections.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];
const host = (options: Parameters<typeof mcpHost>[0] = {}) => {
	const result = mcpHost({
		prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [echo] } }),
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
		expect(first?.text).toContain('// MCP server "octocode"');
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
		expect(during.mcp_contract_octocode).toBe(before.mcp_contract_octocode);
		expect(during.mcp_contract_octocode).not.toContain("function late(");
		expect(h.tools.get("mcp__octocode__late").validationParameters).toBeUndefined();
		await h.fire("model_select", { model: undefined }, h.ctx);
		expect((await h.prompt()).mcp_contract_octocode).toContain("function late(");
	});

	it("picks up externally applied overrides and thin triggers when the model loadout rebuilds", async () => {
		const agentDir = isolatedAgentDir();
		const h = host();
		await h.start();
		const before = await h.prompt();
		const connection = h.state.findServer("octocode")!.connection!;
		const input = { server: "octocode", instructions: connection.instructions, tools: connection.tools };
		const overrides = {
			tools: { shout: "Applied shout wording." },
			triggers: { shout: "Use the applied shout trigger." },
		};
		writeGenerated(generatedDir(agentDir), "octocode", renderServer(input, overrides), {
			...catalogHashes(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			overrides,
			generatedAt: "fixture",
		});
		expect((await h.prompt()).mcp_contract_octocode).toBe(before.mcp_contract_octocode);
		await h.fire("model_select", { model: undefined }, h.ctx);
		expect((await h.prompt()).mcp_contract_octocode).toContain("Applied shout wording.");
		expect(h.tools.get("mcp__octocode__shout").description).toBe("Use the applied shout trigger.");
	});

	it("declares thin stubs, validates against the server's schema and teaches with the signature", async () => {
		isolatedAgentDir();
		const h = host();
		await h.start();
		await h.prompt();
		const shout = h.tools.get("mcp__octocode__shout");
		// Top-level field types only: without them models send arrays and objects as JSON strings (S4 eval).
		expect(shout.parameters).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			additionalProperties: true,
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
		const contract = sections.mcp_contract_octocode;
		expect(contract).toContain("declare namespace octocode {");
		expect(contract).toContain("function shout(");
		expect(contract).toContain("mcp__octocode__<function>");
		// Every server is connected: no status section, and no other MCP section.
		expect(Object.keys(sections).filter((name) => name.startsWith("mcp_"))).toEqual(["mcp_contract_octocode"]);
	});

	it("keeps JSON declarations and writes nothing when mcpPresentation is json", async () => {
		const dir = generatedDir(isolatedAgentDir());
		const h = host({ presentation: "json" });
		await h.start();
		const { mcp_contract_octocode: section } = await h.prompt();
		const shout = h.tools.get("mcp__octocode__shout");
		expect(shout.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
		expect(shout.validationParameters).toBeUndefined();
		expect(section).toContain("full descriptions and schemas");
		expect(section).not.toContain("declare namespace");
		expect(existsSync(join(dir, "octocode.txt"))).toBe(false);
	});

	it("reads mcpPresentation from the settings", async () => {
		isolatedAgentDir();
		const h = host();
		h.pi.getSettings = () => ({ mcpPresentation: "json" }) as never;
		await h.start();
		await h.prompt();
		expect(h.tools.get("mcp__octocode__shout").validationParameters).toBeUndefined();
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

	it("is a no-op in json mode and survives an unwritable store", () => {
		const off = new McpPresentation({ agentDir: tmp, mode: () => "json" });
		off.sync("s", "s", undefined, [tool("a")]);
		expect(off.isThin("s", tool("a"))).toBe(false);
		const blocked = new McpPresentation({ agentDir: () => "/dev/null/x", mode: () => "compact" });
		const a = tool("a");
		blocked.sync("s", "s", undefined, [a]);
		expect(blocked.isThin("s", a)).toBe(true);
		expect(blocked.signature("s", "a")).toContain("function a(");
	});

	it("freezes the prompt copy until rebuild, and a changed tool stops being thin", () => {
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		const a = tool("a");
		presentation.sync("s", "s", "Be careful.", [a]);
		const frozen = presentation.section("s", ["a"]);
		expect(frozen).toContain("Be careful.");
		const changed = tool("a", "Does other work.");
		presentation.sync("s", "s", "Be careful.", [changed, tool("b")]);
		expect(presentation.section("s", ["a"])).toBe(frozen);
		expect(presentation.isThin("s", a)).toBe(true);
		expect(presentation.isThin("s", changed)).toBe(false);
		expect(presentation.isThin("s", tool("b"))).toBe(false);
		expect(presentation.signature("s", "b")).toContain("function b(");
		presentation.rebuild();
		expect(presentation.section("s", ["a"])).toContain("Does other work.");
		expect(presentation.isThin("s", changed)).toBe(true);
	});

	it("reuses a stored file whose hash matches and drops overrides of an older catalog", () => {
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

	it("applies the preset overrides that describe the catalog, only when they pass fidelity", () => {
		const agentDir = tmp();
		const seen: string[] = [];
		let overrides: { tools: Record<string, string> } | undefined = { tools: { a: "Short preset text." } };
		const presentation = new McpPresentation({
			agentDir: () => agentDir,
			mode: () => "compact",
			presetOverrides: (name, input) => {
				seen.push(`${name}:${input.tools.length}`);
				return overrides;
			},
		});
		presentation.sync("s", "s", undefined, [tool("a")]);
		const stored = readGenerated(generatedDir(agentDir), "s")!;
		expect(seen).toEqual(["s:1"]);
		expect(stored.text).toContain("/** Short preset text. */");
		expect(stored.meta.overrides).toEqual(overrides);
		expect(stored.meta.optimizedBy?.model).toBe("preset");

		// An override that fails fidelity (adds a URL) is ignored; the deterministic text is used.
		overrides = { tools: { a: "See https://example.invalid now." } };
		const fresh = tmp();
		new McpPresentation({ agentDir: () => fresh, mode: () => "compact", presetOverrides: () => overrides }).sync(
			"s",
			"s",
			undefined,
			[tool("a")],
		);
		const rejected = readGenerated(generatedDir(fresh), "s")!;
		expect(rejected.text).toContain("/** Does work. */");
		expect(rejected.meta.overrides).toBeUndefined();
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
		h.pi.selectsTools = (_prefix: string, activeByDefault: boolean) => activeByDefault;
		await h.start();
		const server = h.state.findServer("octocode")!;
		expect(server.unselected).toBe(true);
		expect(h.transports).toHaveLength(0);
		await startConnection(h.state, server);
		expect(server.unselected).toBeUndefined();
		expect(h.tools.get("mcp__octocode__shout").defaultActive).toBeUndefined();
	});
});
