import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { SETTINGS_DEFAULTS } from "../../coding-agent/src/core/settings-defaults.ts";
import { DEFAULT_MCP_PROMOTED_BYTES, deferralOf, promotionBudget, recentToolKey } from "../src/deferral.ts";
import { USAGE_FILE_NAME, UsageRecorder, usageCounts } from "../../common/src/usage-counts.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * `mcpExposure: "usage"`: every open tool is declared thin; the promotion snapshot (counts across sessions) never sends
 * a full schema, and only decides whether an on-demand tool is declared from the start (`deferralOf`). The snapshot is
 * fixed for the session and a child takes its coordinator's; pins win; a refused first call counts.
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
		exposure: "usage",
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
const file = (agent: string) => join(agent, USAGE_FILE_NAME);
/** `declaring` main sessions declared `tool`; the first `callers` called it. */
function seed(agent: string, tool: string, declaring: number, callers: number): void {
	for (let i = 0; i < declaring; i++) {
		const recorder = new UsageRecorder(
			() => file(agent),
			() => "main",
		);
		recorder.record("declared", [recentToolKey("docs", tool)]);
		if (i < callers) recorder.record("called", [recentToolKey("docs", tool)]);
	}
}

describe("mcpExposure usage", () => {
	it("defers every tool with no usage data", async () => {
		const cold = await session(dirs());
		expect(cold.mcps).toContain("\n- shout\n");
		expect(cold.mcps).toContain("\n- pick\n");
		expect([...(cold.h.state.recentTools() ?? [])]).toEqual([]);
	});

	it("declares an open tool thin even when the snapshot promotes it, at 10% of 20 declaring sessions", async () => {
		const at = dirs();
		seed(at.agent, "pick", 20, 2);
		seed(at.agent, "shout", 19, 2);
		const next = await session(at);
		expect([...(next.h.state.recentTools() ?? [])]).toEqual(["docs/pick"]);
		expect(next.mcps).toContain("\n- pick\n");
		expect(next.mcps).toContain("\n- shout\n");
		expect(next.h.tools.get("mcp__docs__pick")?.parameters.additionalProperties).toBe(true);
	});

	it("reads the promotion budget from the setting, whose default is the package's", () => {
		expect(SETTINGS_DEFAULTS.mcpPromotedBytes).toBe(DEFAULT_MCP_PROMOTED_BYTES);
		expect(promotionBudget(undefined)).toBe(DEFAULT_MCP_PROMOTED_BYTES);
		expect(promotionBudget(0)).toBe(0);
		expect(promotionBudget(-1)).toBe(DEFAULT_MCP_PROMOTED_BYTES);
	});

	it("lets promotion declare an on-demand tool thin from the start, never in full; recent and a load still do", () => {
		const docs = entry({ toolExposure: { pick: "onDemand" } });
		const promoted = new Set(["docs/pick"]);
		const of = (setting: string, recent: ReadonlySet<string>, loaded: ReadonlySet<string> = new Set()) =>
			deferralOf(docs, ["pick", "shout"], setting, ["mcp"], [], recent, loaded).deferred;
		expect([...of("usage", promoted)]).toEqual(["pick", "shout"]);
		expect([...of("usage", new Set())]).toEqual(["pick", "shout"]);
		expect([...of("recent", promoted)]).toEqual(["shout"]);
		expect([...of("usage", promoted, new Set(["pick"]))]).toEqual(["shout"]);
	});

	it("fixes the snapshot for the running session and hands it to a child", async () => {
		const at = dirs();
		seed(at.agent, "pick", 20, 20);
		const first = await session(at);
		expect([...(first.h.state.recentTools() ?? [])]).toEqual(["docs/pick"]);
		seed(at.agent, "shout", 30, 30);
		expect([...(first.h.state.recentTools() ?? [])]).toEqual(["docs/pick"]);
		expect((await first.h.prompt()).mcps).toContain("\n- shout\n");

		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP_RECENT_TOOLS", JSON.stringify(["docs/pick"]));
		const child = await session(at);
		expect([...(child.h.state.recentTools() ?? [])]).toEqual(["docs/pick"]);
		expect(child.mcps).toContain("\n- shout\n");
		expect(child.mcps).toContain("\n- pick\n");
	});

	it("lets a pin win over the snapshot in both directions", async () => {
		const at = dirs();
		seed(at.agent, "pick", 20, 20);
		const pinned = await session(at, {
			servers: [entry({ toolExposure: { pick: "deferred", shout: "direct" } })],
		});
		expect(pinned.mcps).toContain("\n- pick\n");
		expect(pinned.mcps).not.toContain("\n- shout\n");
	});

	it("counts declared, called and refused sessions, and promotes after a refused first call", async () => {
		const at = dirs();
		const first = await session(at);
		// A deferred tool's refusal hint carries its schema and counts as demand.
		const refuse = () => first.shout().validationHint?.({ envelope: false, properties: ["text"] });
		expect(refuse()).toContain("Input schema");
		refuse();
		await first.h.call("mcp__docs__shout", { text: "hi" });
		const counts = usageCounts(file(at.agent), "main")["docs/shout"];
		expect(counts).toMatchObject({ declared: 1, called: 1, used: 1, refused: 2 });
		const once = usageCounts(file(at.agent), "main")["docs/shout"];
		expect(once?.called).toBe(1);
		// Without a saved snapshot (the next day, say) it is computed again from the counts: the refusals promote `shout`,
		// which stays thin, as every open tool does under `usage`.
		const saved = JSON.parse(readFileSync(file(at.agent), "utf8"));
		saved.snapshots = {};
		writeFileSync(file(at.agent), JSON.stringify(saved));
		const next = await session(at);
		expect([...(next.h.state.recentTools() ?? [])]).toEqual(["docs/shout"]);
		expect(next.mcps).toContain("\n- shout\n");
		expect(next.mcps).toContain("\n- pick\n");
	});
});
