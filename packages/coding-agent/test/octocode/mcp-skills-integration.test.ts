import "../mcp-host.ts";
import { recommendedPresets } from "../../../mcp/src/recommended/index.ts";
import fs from "node:fs";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createMcpExtension } from "../../../mcp/src/index.ts";
import { publishToolRoles, resolveToolRoles } from "../../../mcp/src/roles.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { researchServerLaunch } from "./research-server-launch.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	publishToolRoles(resolveToolRoles([]));
});

describe("installed MCP and skills through the native SDK", () => {
	it.each([
		{ role: "main", owner: "native" },
		{ role: "browser", owner: "native" },
		{ role: "main", owner: "configured" },
		{ role: "browser", owner: "configured" },
		{ role: "main", owner: "configured-default" },
		{ role: "browser", owner: "configured-default" },
	])(
		"loads and fetches skills in the $role session through $owner MCP",
		async ({ role, owner }) => {
			const root = tmp("octocode-mcp-skills-");
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const home = path.join(root, "home");
			for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
			fs.mkdirSync(path.join(cwd, ".git"));
			const evidence = path.join(cwd, "evidence.txt");
			fs.writeFileSync(evidence, "before\n");
			const unrelated = path.join(root, "unrelated.txt");
			fs.writeFileSync(unrelated, "UNRELATED_FILE_MUST_STAY_BLOCKED\n");
			vi.stubEnv("HOME", home);
			vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode"));
			vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("OCTOCODE_MCP", "1");
			vi.stubEnv("OCTOCODE_OFFLINE", "1");
			vi.stubEnv("OCTOCODE_PERMISSION", "workspace");
			vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "0");
			vi.stubEnv("OCTOCODE_SUBAGENT", role === "browser" ? "1" : "0");
			const externalSkill = path.join(root, "external-skill");
			fs.mkdirSync(externalSkill);
			fs.writeFileSync(
				path.join(externalSkill, "SKILL.md"),
				"---\nname: integration-skill\ndescription: Integration fixture\n---\nUse the companion [reference](reference.md).\n",
			);
			fs.writeFileSync(path.join(externalSkill, "reference.md"), "SKILL_REFERENCE_EVIDENCE\n");
			fs.symlinkSync(unrelated, path.join(externalSkill, "escape.txt"));
			const discoveredSkill = path.join(root, "discovered-skill");
			fs.mkdirSync(discoveredSkill);
			fs.writeFileSync(
				path.join(discoveredSkill, "SKILL.md"),
				"---\nname: discovered-skill\ndescription: Discovered fixture\n---\nDISCOVERED_SKILL_EVIDENCE\n",
			);
			if (owner !== "native") {
				const { command, args, env } = researchServerLaunch(cwd, [externalSkill, discoveredSkill]);
				fs.writeFileSync(
					path.join(agentDir, "mcp.json"),
					JSON.stringify({
						mcpServers: {
							octocode: {
								command,
								args,
								// A user entry owns its launch env: the default entry's `${researchRoots}` (workspace, sessions,
								// loaded skills) reaches the skills only when the entry passes it too.
								env: owner === "configured-default" ? { WORKSPACE_ROOT: cwd, ALLOWED_PATHS: "${researchRoots}" } : env,
								exposure: "direct",
							},
						},
					}),
				);
			}
			const faux = createFauxCore({
				provider: "faux",
				models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
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
				api.on("resources_discover", () => ({ skillPaths: [discoveredSkill] }));
			};
			const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [
					{ name: "faux", factory: provider },
					...(owner === "configured-default"
						? []
						: [
								{
									name: "builtin:mcp",
									factory: (api: Parameters<ExtensionFactory>[0]) =>
										createMcpExtension({
											// The default entry as runtime registers it (`default.ts`): its `roles` make localFetch the
											// reader whose reads the file guard credits, and a same-named user entry inherits them.
											presets: recommendedPresets(),
											logPath: path.join(root, "mcp.log"),
										})(api),
								},
							]),
				],
				additionalSkillPaths: [externalSkill],
				// The configured default keeps the built-in MCP host on; the other owners supply their own.
				disabledFeatures: owner === "configured-default" ? ["llama.cpp"] : ["mcp", "llama.cpp"],
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			// A parent builds its child's selection with its MCP roles already published (the registry does so once its
			// servers load); the roles of the default entry stand in for that, as `local research` follows them.
			publishToolRoles(
				resolveToolRoles(
					recommendedPresets().flatMap(({ name, config }) => (config ? [{ name, config, scope: "default" }] : [])),
				),
			);
			const selection =
				role === "browser"
					? parseArgs(
							buildAgentArgs(loadProfiles(cwd, agentDir, false, {}).get("browser"), undefined, {
								dir: path.join(root, "session"),
								id: "integration",
							}),
						)
					: parseArgs([]);
			const { session } = await createTestSession({
				cwd,
				agentDir,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				...(selection.tools ? { tools: selection.tools } : {}),
				...(selection.excludeTools ? { excludeTools: selection.excludeTools } : {}),
			});
			const turns: TranscriptContext[] = [];
			try {
				await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
				await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
				const research = resourceLoader.getSkills().skills.find((skill) => skill.name === "integration-skill")!;
				expect(research).toBeDefined();
				faux.setResponses([
					(context) => {
						turns.push(context);
						const names = getCurrentTools(context.messages).map((tool) => tool.name);
						expect(names).toEqual(expect.arrayContaining(["file", "agent", "archive"]));
						// Browsing defaults to the browser MCP server (docs/native-features.md); no role has a native `browser` tool.
						expect(names).not.toContain("browser");
						// Every child keeps `bash` (SHELL_TOOLS); a read-only role's permission layer refuses its mutations.
						if (role === "browser") expect(names).toContain("bash");
						const reader = names.find((name) => /^mcp__octocode__(localFetch|localGetFileContent)$/.test(name));
						expect(reader).toBeDefined();
						const read = (file: string, end: number): JsonObject =>
							reader!.endsWith("localFetch")
								? { path: file, ranges: [{ startLine: 1, endLine: end }] }
								: { path: file, startLine: 1, endLine: end, minify: "none" };
						expect(getCurrentSystemPrompt(context.messages)).toContain("<name>integration-skill</name>");
						expect(getCurrentSystemPrompt(context.messages)).toContain(
							"Use the skill tool, one call per name, to load every skill",
						);
						return fauxAssistantMessage(
							[
								fauxToolCall(reader!, {
									queries: [
										read(research.filePath, 30),
										read(path.join(externalSkill, "reference.md"), 10),
										read(path.join(discoveredSkill, "SKILL.md"), 10),
										read(evidence, 10),
									],
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						turns.push(context);
						return fauxAssistantMessage(
							[
								fauxToolCall("file", {
									reason: "Update the retrieved fixture",
									queries: [
										{
											type: "write",
											path: evidence,
											content: "after\n",
											reason: "Update the retrieved fixture",
										},
									],
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						turns.push(context);
						return fauxAssistantMessage("Done");
					},
				]);
				await session.prompt("Load the debugging skill and its references.");
				const servers = getMcpSessionStatus(resourceLoader.getEventBus());
				const octocode = servers.find((server) => server.name === "octocode")!;
				expect(octocode).toEqual(expect.objectContaining({ state: "connected", enabled: true }));
				expect(octocode.toolCount).toBeGreaterThan(0);
				expect(octocode.source).toBe(owner === "native" ? "built-in octocode" : path.join(agentDir, "mcp.json"));
				const infoOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				try {
					await session.prompt("/status");
					const info = infoOutput.mock.calls.map(([value]) => String(value)).join("");
					expect(info).toContain("integration-skill");
					expect(info).toContain("octocode: connected");
					expect(info.indexOf("Skills (")).toBeLessThan(info.indexOf("MCPs ("));
				} finally {
					infoOutput.mockRestore();
				}
				expect(turns).toHaveLength(3);
				const results = turns[1].messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(1);
				expect(JSON.stringify(results)).not.toMatch(/Access denied|outside.*allowed|not allowed|isError":true/i);
				expect(JSON.stringify(results)).toContain("SKILL_REFERENCE_EVIDENCE");
				expect(JSON.stringify(results)).toContain("Use the companion");
				expect(JSON.stringify(results)).toContain("DISCOVERED_SKILL_EVIDENCE");
				expect(
					fs.readFileSync(evidence, "utf8"),
					JSON.stringify(turns[2].messages.filter((message) => message.role === "toolResult").at(-1)),
				).toBe("after\n");
				const reader = session
					.getActiveToolNames()
					.find((name) => /^mcp__octocode__(localFetch|localGetFileContent)$/.test(name))!;
				let blocked = "";
				faux.setResponses([
					() =>
						fauxAssistantMessage(
							[
								fauxToolCall(reader, {
									queries: [{ path: unrelated }, { path: path.join(externalSkill, "escape.txt") }],
								}),
							],
							{ stopReason: "toolUse" },
						),
					(context) => {
						blocked = JSON.stringify(context.messages.filter((message) => message.role === "toolResult").at(-1));
						return fauxAssistantMessage("Access stays limited");
					},
				]);
				await session.prompt("Check the unrelated path and the escaping symlink.");
				expect(blocked).toMatch(/outsideAllowedRoots|outside allowed directories/);
				expect(blocked).not.toContain("UNRELATED_FILE_MUST_STAY_BLOCKED");
				let expanded = "";
				faux.setResponses([
					(context) => {
						expanded = JSON.stringify(context.messages.filter((message) => message.role === "user").at(-1));
						return fauxAssistantMessage("Skill invoked");
					},
				]);
				await session.prompt("/skill:integration-skill Use this skill explicitly.");
				expect(expanded).toContain("Use the companion");
				expect(expanded).toContain("Use this skill explicitly.");
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		},
		60_000,
	);
});
