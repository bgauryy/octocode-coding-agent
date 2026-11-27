import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../coding-agent/src/core/features/types.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * `leanSession`: a host that runs a session lean on its model (a small window) has every open MCP tool declared thin,
 * whatever `mcpExposure` says; the question is asked again when the session switches model.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const entry: McpServerEntry = {
	name: "docs",
	config: { command: "echo", description: "docs purpose line" },
	source: "test",
};

/** A host under `mcpExposure: "direct"`, which declares every open tool in full unless the session is lean. */
function host(leanSession?: (model: unknown) => boolean) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const h = mcpHost({
		servers: [entry],
		prepareLaunch: (server) => ({ ...server, config: { ...server.config, command: process.execPath, args: [echo] } }),
		presentation: "declared",
		...(leanSession ? { leanSession } : {}),
	});
	h.api.settings.get = () => ({ mcpExposure: "direct" });
	h.api.tools.getActive = () =>
		[...h.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	hosts.push(h);
	return h;
}

/** Whether each declared `docs` tool is thin (its parameters open, `deferredInputSchema`) after a first prompt on `model`. */
async function thin(h: ReturnType<typeof host>, model: { contextWindow: number }) {
	const ctx = { ...h.ctx, model } as unknown as FeatureContext;
	await h.start(ctx);
	const { mcps = "" } = await h.prompt(ctx);
	const tools = [...h.tools.values()].filter((tool) => tool.name.startsWith("mcp__docs__"));
	return { mcps, thin: tools.map((tool) => tool.parameters?.additionalProperties === true) };
}

const smallWindow = (model: unknown) => ((model as { contextWindow?: number }).contextWindow ?? 0) < 64_000;

describe("a lean MCP session", () => {
	it("declares every open tool thin on a model the host runs lean, and in full on any other", async () => {
		const lean = await thin(host(smallWindow), { contextWindow: 32_768 });
		expect(lean.thin.length).toBeGreaterThan(0);
		expect(new Set(lean.thin)).toEqual(new Set([true]));
		expect(lean.mcps).toContain("\n- shout\n");
		const full = await thin(host(smallWindow), { contextWindow: 200_000 });
		expect(new Set(full.thin)).toEqual(new Set([false]));
		expect(full.mcps).not.toContain("\n- shout\n");
	});

	it("follows the setting when the host passes no lean decision", async () => {
		expect(new Set((await thin(host(), { contextWindow: 32_768 })).thin)).toEqual(new Set([false]));
	});

	it("reads the setting again as `deferred` once the session switches to a small model", async () => {
		const h = host(smallWindow);
		await thin(h, { contextWindow: 200_000 });
		expect(h.state.exposureSetting()).toBe("direct");
		await h.fire("model_select", {}, { ...h.ctx, model: { contextWindow: 32_768 } });
		expect(h.state.exposureSetting()).toBe("deferred");
	});
});
