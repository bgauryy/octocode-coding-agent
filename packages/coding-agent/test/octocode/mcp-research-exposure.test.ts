import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createMcpFeature } from "../../../mcp/src/index.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

afterEach(() => vi.unstubAllEnvs());

/** The namespace a session gives the fixture server's tools. */
const PREFIX = "mcp__fixture__";

/** The tools a session declares to the model (and whether codemode is among them) when the user's mcp.json runs the `fixture` server. */
async function declaredTools(
	role: "main" | "researcher",
	server: Record<string, unknown> | undefined,
	expectConnected = true,
	contextWindow = 200_000,
): Promise<string[]> {
	const root = tmp("octocode-mcp-exposure-");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
	fs.mkdirSync(path.join(cwd, ".git"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OCTOCODE_MCP", "1");
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	vi.stubEnv("OCTOCODE_SUBAGENT", role === "main" ? "0" : "1");
	if (server) fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: server } }));
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow, maxTokens: 4096 }],
	});
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models,
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([
			{ name: "faux", factory: provider },
			{
				name: "builtin:mcp",
				factory: createMcpFeature({ presets: [], logPath: path.join(root, "mcp.log") }),
			},
		]),
		disabledFeatures: ["mcp"],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	const selection =
		role === "main"
			? parseArgs([])
			: parseArgs(
					buildAgentArgs(loadProfiles(cwd, agentDir, false, {}).get(role), undefined, {
						dir: path.join(root, "session"),
						id: "exposure",
					}),
				);
	const { session } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		...(selection.tools ? { tools: selection.tools } : {}),
		...(selection.excludeTools ? { excludeTools: selection.excludeTools } : {}),
	});
	try {
		await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
		let declared: string[] = [];
		// The first prompt waits up to 10 s for the server; a slow start joins a later prompt.
		for (let attempt = 0; attempt < 6; attempt++) {
			faux.setResponses([
				(context) => {
					declared = getCurrentTools(context.messages).map((tool) => tool.name);
					return fauxAssistantMessage("ok");
				},
			]);
			await session.prompt("Which tools do you have?");
			if (!expectConnected || declared.some((name) => name.startsWith(PREFIX))) break;
		}
		return declared;
	} finally {
		await session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}

/** A fixture server the test controls: its tool set is its own, never a shipped server's. */
const fixture = () => ({
	command: process.execPath,
	args: [path.join(import.meta.dirname, "fixtures", "echo-mcp.mjs")],
});
const FIXTURE_TOOLS = ["shout", "pick", "fail", "roots", "grow", "shrink"].map((name) => `${PREFIX}${name}`);
const ownTools = (declared: string[]) => declared.filter((name) => name.startsWith(PREFIX));

describe("MCP tools declared for a user-owned server", () => {
	it.each(["main", "researcher"] as const)(
		"declares every tool the server lists directly in the %s session, with no tool_search",
		async (role) => {
			const declared = await declaredTools(role, fixture());
			expect(declared).not.toContain("codemode");
			expect(declared).not.toContain("tool_search");
			expect(ownTools(declared)).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
		},
		60_000,
	);

	it("lets mcp.json hide single tools", async () => {
		const one = await declaredTools("main", { ...fixture(), toolExposure: { fail: "hidden" } });
		expect(one).not.toContain(`${PREFIX}fail`);
		expect(one).toContain(`${PREFIX}shout`);
	}, 60_000);

	it.each(["main", "researcher"] as const)(
		"keeps the default catalog direct in the %s session even with a small context window",
		async (role) => {
			const declared = await declaredTools(role, fixture(), true, 8_000);
			expect(ownTools(declared)).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
		},
		60_000,
	);

	it("lets an explicit server exposure or tool exposure in mcp.json win over the default", async () => {
		const hidden = await declaredTools("main", { ...fixture(), exposure: "hidden" }, false);
		expect(ownTools(hidden)).toEqual([]);
		const oneTool = await declaredTools("main", { ...fixture(), toolExposure: { shout: "hidden" } });
		expect(ownTools(oneTool)).toEqual(expect.arrayContaining(FIXTURE_TOOLS.filter((name) => !name.endsWith("shout"))));
		expect(oneTool).not.toContain(`${PREFIX}shout`);
		const all = await declaredTools("main", { ...fixture(), exposure: "direct" });
		expect(ownTools(all)).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
	}, 120_000);

	it("uses the same direct default for every server and tool name", async () => {
		const { getMcpToolExposure } = await import("../../../mcp/src/servers.ts");
		for (const tool of ["alpha", "beta_one", "local_gamma"])
			expect(getMcpToolExposure({ command: "x" }, tool)).toBe("direct");
		expect(getMcpToolExposure({ command: "x", exposure: "hidden" }, "alpha")).toBe("hidden");
		expect(getMcpToolExposure({ command: "x", toolExposure: { "local*": "hidden" } }, "local_gamma")).toBe("hidden");
	});
});
