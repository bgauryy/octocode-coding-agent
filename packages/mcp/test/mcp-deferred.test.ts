import { join } from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * Deferred exposure (`exposure: "deferred"`, or `mcpExposure: "auto:<bytes>"` past its budget): the server's block
 * lists its purpose and one line per tool; the `mcp` tool returns the full upstream text as a tool result, so the
 * cached prefix (sections and declarations) stays byte-identical, and calls are still validated against the full schema.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const SHOUT_SCHEMA = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
	additionalProperties: false,
};
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const entry = (name: string, config: Partial<McpServerEntry["config"]> = {}): McpServerEntry => ({
	name,
	config: { command: "echo", description: `${name} purpose line`, ...config } as McpServerEntry["config"],
	source: "test",
});

/** A host whose agent declares the `mcp` tool (the default selection does), unless `manage` is false. */
function host(servers: McpServerEntry[], options: Parameters<typeof mcpHost>[0] = {}, manage = true) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const h = mcpHost({
		servers,
		prepareLaunch: (server) => ({ ...server, config: { ...server.config, command: process.execPath, args: [echo] } }),
		presentation: "compact",
		...options,
	});
	h.api.tools.getActive = () =>
		[...h.tools.values()]
			.filter((tool) => tool.exposure !== "hidden" && (manage || tool.name !== "mcp"))
			.map((tool) => tool.name);
	hosts.push(h);
	return h;
}

const blockOf = (mcps: string | undefined, name: string): string => {
	const start = mcps?.indexOf(`<mcp name="${name}"`) ?? -1;
	expect(start, `block of ${name}`).toBeGreaterThanOrEqual(0);
	return mcps!.slice(start, mcps!.indexOf("</mcp>", start) + "</mcp>".length);
};
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");
const declarations = (h: ReturnType<typeof mcpHost>) =>
	JSON.stringify(
		[...h.tools.values()]
			.filter((tool) => tool.name.startsWith("mcp__"))
			.map(({ name, description, parameters, exposure }) => ({ name, description, parameters, exposure })),
	);

describe("deferred MCP exposure", () => {
	it("lists only the purpose line and one trigger line per tool in the server's block", async () => {
		const h = host([entry("docs", { exposure: "deferred" })]);
		await h.start();
		const { mcps } = await h.prompt();
		const block = blockOf(mcps, "docs");
		expect(block).toContain('<mcp name="docs" tools="mcp__docs__*">\ndocs purpose line\n');
		expect(block).toContain("\n- shout: Uppercase the given text\n");
		expect(block).toContain("\n- pick: Echo union queries back (stand-in for Octocode operation branches)\n");
		expect(block).toContain("\n- localFetch: Read files (stand-in for Octocode)\n");
		// Only per-tool text stays out of the prefix: no generated file, no description, no schema. The server's
		// instructions stay.
		expect(block).toContain("Echo test server.");
		expect(block).not.toContain("declare namespace");
		expect(block).not.toContain("function shout(");
		expect(block).not.toContain("searchText");
		// The section says once how to load a deferred tool.
		expect(mcps).toContain("intent `tools`");
	});

	it("shows the server's instructions exactly as a direct block does, before the index lines", async () => {
		const instructionsLine = async (exposure: "direct" | "deferred") => {
			const h = host([entry("docs", { exposure })]);
			await h.start();
			const block = blockOf((await h.prompt()).mcps, "docs");
			return { block, line: block.split("\n").find((candidate) => candidate.includes("Echo test server.")) };
		};
		const direct = await instructionsLine("direct");
		const deferred = await instructionsLine("deferred");
		expect(direct.line).toBeDefined();
		expect(deferred.line).toBe(direct.line);
		expect(deferred.block.indexOf(deferred.line!)).toBeLessThan(deferred.block.indexOf("\n- shout:"));
	});

	it("keeps the instructions of a fully deferred server in json presentation too", async () => {
		const h = host([entry("docs", { exposure: "deferred" })], { presentation: "json" });
		await h.start();
		const block = blockOf((await h.prompt()).mcps, "docs");
		expect(block).toContain("Echo test server.");
		expect(block).toContain("\n- shout: Uppercase the given text\n");
		expect(block).not.toContain("Input schema");
	});

	it("returns the full upstream description and schema on demand, by tool or call name, and points to the instructions", async () => {
		const h = host([entry("docs", { exposure: "deferred" })]);
		await h.start();
		await h.prompt();
		const tool = text(await h.call("mcp", { intent: "tools", server: "docs", tool: "shout" }));
		expect(tool).toContain("shout [deferred] — Uppercase the given text");
		expect(tool).toContain(`Input schema:\n${JSON.stringify(SHOUT_SCHEMA, null, 2)}`);
		expect(text(await h.call("mcp", { intent: "tools", server: "docs", tool: "mcp__docs__shout" }))).toBe(tool);
		const server = text(await h.call("mcp", { intent: "tools", server: "docs" }));
		// The prompt's block already holds the instructions whole, so the listing names the block instead.
		expect(server).not.toContain("Echo test server.");
		expect(server).toContain('<mcps> section, block "docs"');
		expect(server).toContain("shout [deferred] — Uppercase the given text");
	});

	it("declares deferred tools thin and validates calls against the server's full schema", async () => {
		const h = host([entry("docs", { exposure: "deferred" })]);
		await h.start();
		await h.prompt();
		const shout = h.tools.get("mcp__docs__shout");
		expect(shout.exposure).toBe("direct");
		expect(shout.description).toBe("Uppercase the given text");
		expect(shout.validationParameters).toEqual(SHOUT_SCHEMA);
		const call = (args: Record<string, unknown>) =>
			validateToolArguments(shout, { type: "toolCall", id: "c", name: shout.name, arguments: args as never });
		expect(() => call({ text: { nested: true } })).toThrow();
		expect(() => call({})).toThrow();
		expect(call({ text: "hi" })).toEqual({ text: "hi" });
		expect(text(await h.call("mcp__docs__shout", { text: "hi" }))).toContain("HI");
	});

	it("keeps the prefix byte-identical after a tool's text is loaded (T5)", async () => {
		const h = host([entry("docs", { exposure: "deferred" })]);
		await h.start();
		const before = await h.prompt();
		const declared = declarations(h);
		await h.call("mcp", { intent: "tools", server: "docs", tool: "shout" });
		await h.call("mcp", { intent: "tools", server: "docs" });
		await h.call("mcp__docs__shout", { text: "hi" });
		const after = await h.prompt();
		expect(after).toEqual(before);
		expect(declarations(h)).toBe(declared);
	});

	it("describes a deferred server in full when the agent cannot load text (no `mcp` tool)", async () => {
		const h = host([entry("docs", { exposure: "deferred" })], {}, false);
		await h.start();
		const block = blockOf((await h.prompt()).mcps, "docs");
		expect(block).toContain("function shout(");
		expect(block).toContain("Echo test server.");
	});

	it("defers a single tool by toolExposure and keeps the rest of the server direct", async () => {
		const h = host([entry("docs", { toolExposure: { pick: "deferred" } })], { exposure: "direct" });
		await h.start();
		const block = blockOf((await h.prompt()).mcps, "docs");
		expect(block).toContain("Echo test server.");
		expect(block).toContain("function shout(");
		expect(block).not.toContain("searchText");
		expect(block).toContain("\n- pick: Echo union queries back (stand-in for Octocode operation branches)\n");
	});
});

describe("mcpExposure auto threshold", () => {
	const directBlock = async (servers: McpServerEntry[], exposure: string) => {
		const h = host(servers, { exposure });
		await h.start();
		return (await h.prompt()).mcps;
	};

	it("keeps servers direct while their text fits the budget, and defers them past it", async () => {
		const fits = await directBlock([entry("docs")], "auto:1000000");
		expect(blockOf(fits, "docs")).toContain("function shout(");
		const over = await directBlock([entry("docs")], "auto:200");
		expect(blockOf(over, "docs")).not.toContain("function shout(");
		expect(blockOf(over, "docs")).toContain("\n- shout: Uppercase the given text\n");
	});

	it("fills the budget in server-name order and never overrides an explicit exposure", async () => {
		const one = blockOf(await directBlock([entry("alpha")], "auto:1000000"), "alpha");
		const budget = Math.ceil(Buffer.byteLength(one) * 1.5);
		const mcps = await directBlock([entry("beta"), entry("alpha")], `auto:${budget}`);
		expect(blockOf(mcps, "alpha")).toContain("function shout(");
		expect(blockOf(mcps, "beta")).not.toContain("function shout(");
		const explicit = await directBlock([entry("alpha", { exposure: "direct" })], "auto:200");
		expect(blockOf(explicit, "alpha")).toContain("function shout(");
	});

	it("reads `deferred` and the default from the setting", async () => {
		expect(blockOf(await directBlock([entry("docs")], "deferred"), "docs")).not.toContain("function shout(");
		const h = host([entry("docs")]);
		h.api.settings.get = () => ({ mcpExposure: "auto:200" });
		await h.start();
		expect(blockOf((await h.prompt()).mcps, "docs")).not.toContain("function shout(");
		const direct = host([entry("docs")]);
		direct.api.settings.get = () => ({ mcpExposure: "direct" });
		await direct.start();
		expect(blockOf((await direct.prompt()).mcps, "docs")).toContain("function shout(");
		// Without a setting, `recent`: a tool this working directory used in the last 24 hours is direct, the rest deferred.
		const plain = host([entry("docs")], { recentTools: new Set(["docs/shout"]) });
		await plain.start();
		const block = blockOf((await plain.prompt()).mcps, "docs");
		expect(block).toContain("function shout(");
		expect(block).not.toContain("function pick(");
		expect(block).toContain("\n- pick: Echo union queries back (stand-in for Octocode operation branches)\n");
	});
});

describe("mcpExposure auto threshold and connection order", () => {
	const tool = { name: "shout", description: "Uppercase the text", inputSchema: SHOUT_SCHEMA } as never;
	const presentation = () => {
		const dir = tmp();
		return new McpPresentation({ agentDir: () => dir, mode: () => "compact" });
	};
	const describeServer = (p: McpPresentation, name: string, ready: boolean, budget: number) => {
		if (ready) p.sync(name, name, undefined, [tool]);
		return p.describe(name, ["shout"], undefined, ready, {
			deferred: new Set(),
			auto: { tools: new Set(["shout"]), budget },
		});
	};

	it("measures a server that connects late against the servers that sort before it only", () => {
		const probe = presentation();
		const size = Buffer.byteLength(describeServer(probe, "alpha", true, 1e9).contract ?? "");
		const budget = Math.ceil(size * 1.5);
		const p = presentation();
		// alpha is still pending at the first prompt; beta is described direct.
		expect(describeServer(p, "alpha", false, budget).pending).toBe(true);
		expect(describeServer(p, "beta", true, budget).deferred.size).toBe(0);
		// alpha connects: nothing sorts before it, so it stays direct although beta already spent the budget's bulk.
		expect(describeServer(p, "alpha", true, budget).deferred.size).toBe(0);
		// beta's description does not flip when alpha arrives.
		expect(describeServer(p, "beta", true, budget).deferred.size).toBe(0);
	});

	it("defers a later-named server past the budget the earlier-named ones spent, whatever the connection order", () => {
		const probe = presentation();
		const size = Buffer.byteLength(describeServer(probe, "alpha", true, 1e9).contract ?? "");
		const budget = Math.ceil(size * 1.5);
		const p = presentation();
		expect(describeServer(p, "alpha", true, budget).deferred.size).toBe(0);
		expect([...describeServer(p, "beta", true, budget).deferred]).toEqual(["shout"]);
	});
});
