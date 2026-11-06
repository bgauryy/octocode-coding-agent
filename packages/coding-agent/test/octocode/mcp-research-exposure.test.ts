import "../mcp-host.ts";
import { recommendedPresets } from "../../../mcp/src/recommended/index.ts";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { researchServerLaunch } from "./research-server-launch.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** The tools a session declares to the model (and whether codemode is among them) when the user's mcp.json runs `octocode`. */
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
	if (server) fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { octocode: server } }));
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow, maxTokens: 4096 }],
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
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
		extensionFactories: [
			{ name: "faux", factory: provider },
			{
				name: "builtin:mcp",
				factory: createMcpExtension({ presets: recommendedPresets(), logPath: path.join(root, "mcp.log") }),
			},
		],
		disabledFeatures: ["mcp", "llama.cpp"],
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
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
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
			if (!expectConnected || declared.some((name) => name.startsWith("mcp__octocode__"))) break;
		}
		return declared;
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}

const real = () => {
	const { command, args, env } = researchServerLaunch(process.cwd());
	return { command, args, env: { ...env, ALLOWED_PATHS: process.cwd() } };
};
const RESEARCH = ["localFetch", "localSearch", "structureSearch", "astSearch", "lspSearch"].map(
	(name) => `mcp__octocode__${name}`,
);

const GITHUB_DIRECT = ["ghSearchCode", "ghGetFileContent", "ghStructure"].map((name) => `mcp__octocode__${name}`);
const HISTORY_AND_REGISTRY = ["ghSearchHistory", "ghGetHistoryItem", "artifactSearch", "ghSearchRepo"].map(
	(name) => `mcp__octocode__${name}`,
);

describe("Octocode research tools declared for a user-owned server", () => {
	it.each(["main", "researcher"] as const)(
		"declares local, GitHub, and package tools directly by default in the %s session",
		async (role) => {
			const declared = await declaredTools(role, real());
			expect(declared).not.toContain("codemode");
			const octocode = declared.filter((name) => name.startsWith("mcp__octocode__"));
			expect(octocode).toEqual(expect.arrayContaining(RESEARCH));
			expect(octocode).toContain("mcp__octocode__ghSearchCode");
		},
		60_000,
	);

	it.each(["main", "researcher"] as const)(
		"declares the GitHub history and registry tools directly too in the %s session, with no tool_search",
		async (role) => {
			const declared = await declaredTools(role, undefined);
			const octocode = declared.filter((name) => name.startsWith("mcp__octocode__"));
			expect(octocode).toEqual(expect.arrayContaining([...RESEARCH, ...GITHUB_DIRECT, ...HISTORY_AND_REGISTRY]));
			expect(declared).not.toContain("tool_search");
		},
		60_000,
	);

	it("lets mcp.json hide single tools", async () => {
		const one = await declaredTools("main", { ...real(), toolExposure: { ghSearchRepo: "hidden" } });
		expect(one).not.toContain("mcp__octocode__ghSearchRepo");
		expect(one).toContain("mcp__octocode__ghSearchHistory");
	}, 60_000);

	it.each(["main", "researcher"] as const)(
		"keeps the default catalog direct in the %s session even with a small context window",
		async (role) => {
			const declared = await declaredTools(role, real(), true, 8_000);
			expect(declared).toEqual(expect.arrayContaining(RESEARCH));
			expect(declared).toContain("mcp__octocode__ghSearchCode");
		},
		60_000,
	);

	it("lets an explicit server exposure or tool exposure in mcp.json win over the default", async () => {
		const hidden = await declaredTools("main", { ...real(), exposure: "hidden" }, false);
		expect(hidden.filter((name) => name.startsWith("mcp__octocode__"))).toEqual([]);
		const oneTool = await declaredTools("main", { ...real(), toolExposure: { localFetch: "hidden" } });
		expect(oneTool.filter((name) => name.startsWith("mcp__octocode__")).sort()).toEqual(
			expect.arrayContaining(RESEARCH.filter((name) => !name.endsWith("localFetch"))),
		);
		expect(oneTool).not.toContain("mcp__octocode__localFetch");
		const all = await declaredTools("main", { ...real(), exposure: "direct" });
		expect(all.filter((name) => name.startsWith("mcp__octocode__")).length).toBeGreaterThan(RESEARCH.length);
	}, 120_000);

	it("uses the same direct default for Octocode and other servers", async () => {
		const { getMcpToolExposure } = await import("../../../mcp/src/servers.ts");
		for (const tool of ["localFetch", "ghSearchCode", "ghSearchHistory"])
			expect(getMcpToolExposure({ command: "x" }, tool)).toBe("direct");
		expect(getMcpToolExposure({ command: "x", exposure: "hidden" }, "localFetch")).toBe("hidden");
		expect(getMcpToolExposure({ command: "x", toolExposure: { "local*": "hidden" } }, "localFetch")).toBe("hidden");
	});
});
