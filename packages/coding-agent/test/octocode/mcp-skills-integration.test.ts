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
import { getBundledSkillsDir } from "../../src/config.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { getMcpSessionStatus } from "../../src/extensions/mcp/status.ts";
import { octocodeLaunch } from "../../src/octocode/mcp/octocode.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

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
				const { command, args, env } = octocodeLaunch(cwd, process.env, undefined, [
					getBundledSkillsDir(),
					externalSkill,
					discoveredSkill,
				]);
				fs.writeFileSync(
					path.join(agentDir, "mcp.json"),
					JSON.stringify({
						mcpServers: {
							octocode: {
								command,
								args,
								env: owner === "configured-default" ? { WORKSPACE_ROOT: cwd } : env,
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
			const provider: ExtensionFactory = (pi) => {
				pi.registerProvider("faux", {
					name: "Faux",
					api: faux.api,
					baseUrl: "http://127.0.0.1:0",
					apiKey: "test",
					models: faux.models,
					streamSimple: faux.streamSimple,
				} as never);
				pi.on("resources_discover", () => ({ skillPaths: [discoveredSkill] }));
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
						: [{ name: "builtin:mcp", factory: createMcpExtension({ logPath: path.join(root, "mcp.log") }) }]),
				],
				additionalSkillPaths: [externalSkill],
				...(owner === "configured-default" ? { additionalExtensionPaths: ["builtin:mcp"] } : {}),
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const selection =
				role === "browser"
					? parseArgs(
							buildAgentArgs(loadProfiles(cwd, agentDir, false, {}).get("browser")!, undefined, {
								dir: path.join(root, "session"),
								id: "integration",
							}),
						)
					: parseArgs([]);
			const { session } = await createAgentSession({
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
				const research = resourceLoader.getSkills().skills.find((skill) => skill.name === "octocode-research")!;
				expect(research).toBeDefined();
				faux.setResponses([
					(context) => {
						turns.push(context);
						const names = getCurrentTools(context.messages).map((tool) => tool.name);
						expect(names).toEqual(expect.arrayContaining(["file", "agent", "archive"]));
						expect(names.includes("browser")).toBe(role === "browser");
						if (role === "browser") expect(names).not.toContain("bash");
						const reader = names.find((name) => /^mcp__octocode__(localFetch|localGetFileContent)$/.test(name));
						expect(reader).toBeDefined();
						const read = (file: string, end: number): JsonObject =>
							reader!.endsWith("localFetch")
								? { path: file, ranges: [`1-${end}`] }
								: { path: file, startLine: 1, endLine: end, minify: "none" };
						expect(getCurrentSystemPrompt(context.messages)).toContain("<name>octocode-research</name>");
						expect(getCurrentSystemPrompt(context.messages)).toContain("Octocode localFetch");
						return fauxAssistantMessage(
							[
								fauxToolCall(reader!, {
									queries: [
										read(research.filePath, 30),
										read(path.join(research.baseDir, "references", "octocode-usage.md"), 10),
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
									queries: [
										{
											type: "write",
											path: evidence,
											content: "after\n",
											reasoning: "Update the retrieved fixture",
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
				await session.prompt("Load the research skill and its references.");
				const servers = getMcpSessionStatus(resourceLoader.getEventBus());
				expect(servers).toEqual([expect.objectContaining({ name: "octocode", state: "connected", enabled: true })]);
				expect(servers[0]!.toolCount).toBeGreaterThan(0);
				expect(servers[0]!.source).toBe(owner === "native" ? "built-in Octocode" : path.join(agentDir, "mcp.json"));
				const infoOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				try {
					await session.prompt("/info");
					const info = infoOutput.mock.calls.map(([value]) => String(value)).join("");
					expect(info).toContain("integration-skill");
					expect(info).toContain("octocode: connected");
					expect(info.indexOf("Skills (")).toBeLessThan(info.indexOf("MCPs ("));
				} finally {
					infoOutput.mockRestore();
				}
				expect(turns).toHaveLength(3);
				const results = turns[1]!.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(1);
				expect(JSON.stringify(results)).not.toMatch(/Access denied|outside.*allowed|not allowed|isError":true/i);
				expect(JSON.stringify(results)).toContain("SKILL_REFERENCE_EVIDENCE");
				expect(JSON.stringify(results)).toContain("Octocode Research");
				expect(JSON.stringify(results)).toContain("DISCOVERED_SKILL_EVIDENCE");
				expect(
					fs.readFileSync(evidence, "utf8"),
					JSON.stringify(turns[2]!.messages.filter((message) => message.role === "toolResult").at(-1)),
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
