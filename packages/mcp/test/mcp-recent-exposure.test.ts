import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { DEFAULT_MCP_EXPOSURE_SETTING, recentToolKey } from "../src/deferral.ts";
import { recommendedPresets } from "../src/recommended/index.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * `mcpExposure: "recent"`: a tool the working directory called in the last 24 hours is declared in full; any other is
 * deferred with the server's whole description, stays callable and gets its schema in a failed validation. The set is
 * fixed for the session, read again by the next one, and a child takes its coordinator's.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const SHOUT = "Uppercase the given text. Returns it as one line.";
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const entry = (config: Partial<McpServerEntry["config"]> = {}): McpServerEntry => ({
	name: "docs",
	config: { command: "echo", description: "docs purpose line", ...config } as McpServerEntry["config"],
	source: "test",
});

async function session(dirs: { agent: string; cwd: string }, options: Parameters<typeof mcpHost>[0] = {}) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dirs.agent);
	const h = mcpHost({
		servers: [entry()],
		prepareLaunch: (launched) => ({
			...launched,
			config: { ...launched.config, command: process.execPath, args: [echo], env: { ECHO_SHOUT_DESCRIPTION: SHOUT } },
		}),
		presentation: "declared",
		exposure: "recent",
		cwd: dirs.cwd,
		...options,
	});
	h.api.tools.getActive = () =>
		[...h.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	hosts.push(h);
	await h.start();
	const sections = await h.prompt();
	return { h, mcps: sections.mcps ?? "", shout: () => h.tools.get("mcp__docs__shout") };
}

const dirs = () => ({ agent: tmp(), cwd: tmp() });
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");

describe("mcpExposure recent", () => {
	it("is not the default (usage is), and only FreeLlama, all on demand, sets its own exposure past the setting", () => {
		expect(DEFAULT_MCP_EXPOSURE_SETTING).toBe("usage");
		const presets = recommendedPresets();
		expect(presets.map(({ name }) => name)).toContain("octocode");
		for (const { name, config } of presets)
			expect(config?.exposure, name).toBe(name === "freellama" ? "onDemand" : undefined);
	});

	it("defers an unused tool with the server's whole description and thin parameters", async () => {
		const cold = await session(dirs());
		expect(cold.mcps).toContain("\n- shout\n");
		expect(cold.shout().description).toBe(SHOUT);
		expect(cold.shout().parameters).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			additionalProperties: true,
			required: ["text"],
		});
		expect(text(await cold.h.call("mcp__docs__shout", { text: "hi" }))).toContain("HI");
	});

	it("puts the server's schema in a failed validation of a deferred tool", async () => {
		const cold = await session(dirs());
		const hint = cold.shout().validationHint?.({ envelope: false, properties: ["text"] });
		expect(hint).toContain("Input schema (JSON Schema):");
		expect(hint).toContain('"required":["text"]');
	});

	it("keeps the set for the session and declares a called tool in full in the next one", async () => {
		const at = dirs();
		const first = await session(at);
		await first.h.call("mcp__docs__shout", { text: "hi" });
		expect((await first.h.prompt()).mcps).toContain("\n- shout\n");
		expect(first.shout().parameters.additionalProperties).toBe(true);

		const next = await session(at);
		expect(next.mcps).not.toContain("\n- shout\n");
		expect(next.mcps).toContain("\n- pick\n");
		expect(next.shout().parameters.required).toEqual(["text"]);

		const elsewhere = await session({ agent: at.agent, cwd: tmp() });
		expect(elsewhere.mcps).toContain("\n- shout\n");
	});

	it("lets a tool's own exposure win", async () => {
		const pinned = await session(dirs(), { servers: [entry({ toolExposure: { shout: "direct" } })] });
		expect(pinned.mcps).not.toContain("\n- shout\n");
		expect(pinned.mcps).toContain("\n- pick\n");
	});

	it("takes the coordinator's set in a subagent and hands its own to a child", async () => {
		const at = dirs();
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP_RECENT_TOOLS", JSON.stringify([recentToolKey("docs", "pick")]));
		const child = await session(at);
		expect(child.mcps).toContain("\n- shout\n");
		expect(child.mcps).not.toContain("\n- pick\n");
		expect([...(child.h.state.recentTools() ?? [])]).toEqual(["docs/pick"]);
	});

	it("declares again, byte for byte, the set a resumed or reloaded session saved; a new session reads the record", async () => {
		const at = dirs();
		// The session's branch as the host keeps it: the record goes there, and a later start of the session reads it.
		const branch: unknown[] = [];
		const run = async (entries: unknown[]) => {
			vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", at.agent);
			const h = mcpHost({
				servers: [entry()],
				prepareLaunch: (launched) => ({
					...launched,
					config: {
						...launched.config,
						command: process.execPath,
						args: [echo],
						env: { ECHO_SHOUT_DESCRIPTION: SHOUT },
					},
				}),
				presentation: "declared",
				exposure: "recent",
				cwd: at.cwd,
			});
			hosts.push(h);
			h.api.tools.getActive = () =>
				[...h.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
			h.api.session.appendEntry = (customType: string, data: unknown) =>
				entries.push({ type: "custom", customType, data });
			const ctx = {
				...h.ctx,
				sessionManager: { buildSessionProjection: () => ({ messages: [] }), getBranch: () => entries },
			} as unknown as typeof h.ctx;
			await h.start(ctx);
			const sections = await h.prompt(ctx);
			await h.fire("agent_start", { type: "agent_start" }, ctx);
			const tools = JSON.stringify(
				[...h.tools.values()]
					.filter((tool) => tool.name.startsWith("mcp__docs__"))
					.map((tool) => [tool.name, tool.description, tool.parameters]),
			);
			return { h, tools, mcps: sections.mcps ?? "" };
		};
		const first = await run(branch);
		expect(branch).toEqual([{ type: "custom", customType: "mcp-recent-tools", data: { cwd: at.cwd, tools: [] } }]);
		// This folder calls the tool during the session: the record changes, the session's set does not.
		await first.h.call("mcp__docs__shout", { text: "hi" });

		const resumed = await run(branch);
		expect(resumed.tools).toBe(first.tools);
		expect(resumed.mcps).toBe(first.mcps);
		// It holds the set already: nothing more is saved.
		expect(branch).toHaveLength(1);

		const fresh = await run([]);
		expect(fresh.tools).not.toBe(first.tools);
		expect(fresh.mcps).not.toContain("\n- shout\n");
	});

	it("changes nothing under the default setting", async () => {
		const direct = await session(dirs(), { exposure: "direct" });
		expect(direct.mcps).not.toContain("\n- shout");
		expect(direct.h.state.recentTools()).toBeUndefined();
	});
});
