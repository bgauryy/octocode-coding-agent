import fs from "node:fs";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type JsonObject,
} from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { octocodeLaunch } from "../../src/octocode/mcp/octocode.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it.each(["native", "configured-default", "configured-explicit"] as const)(
	"reads loaded skill resources independently of command visibility through %s MCP",
	async (owner) => {
		const root = tmp("mcp-skill-resource-");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const home = path.join(root, "home");
		for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
		fs.mkdirSync(path.join(cwd, ".git"));
		for (const [key, value] of Object.entries({
			HOME: home,
			OCTOCODE_HOME: path.join(home, ".octocode"),
			OCTOCODE_CODING_AGENT_DIR: agentDir,
			OCTOCODE_MCP: "1",
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_PERMISSION: "workspace",
			OCTOCODE_EXTRA_SKILLS: "0",
			OCTOCODE_SUBAGENT: "0",
		}))
			vi.stubEnv(key, value);
		const makeSkill = (folder: string, name: string, extra = "") => {
			const dir = path.join(root, folder);
			fs.mkdirSync(dir);
			fs.writeFileSync(
				path.join(dir, "SKILL.md"),
				`---\nname: ${name}\ndescription: Resource fixture\n${extra}---\nBODY_${folder}\nUse reference.md\n`,
			);
			fs.writeFileSync(path.join(dir, "reference.md"), `REFERENCE_${folder}\n`);
			return dir;
		};
		const winner = makeSkill("winner", "collision");
		const loser = makeSkill("loser", "collision");
		const modelOnly = makeSkill(
			"model-only",
			"model-only",
			"user-invocable: false\n",
		);
		const unrelated = path.join(root, "unrelated.txt");
		fs.writeFileSync(unrelated, "UNRELATED_SECRET\n");
		fs.symlinkSync(unrelated, path.join(loser, "escape.txt"));
		if (owner !== "native") {
			const { command, args } = octocodeLaunch(cwd, process.env);
			fs.writeFileSync(
				path.join(agentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						octocode: {
							command,
							args,
							env: {
								WORKSPACE_ROOT: cwd,
								...(owner === "configured-explicit"
									? { ALLOWED_PATHS: cwd }
									: {}),
							},
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
		let commands: string[] = [];
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: [winner, loser, modelOnly],
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			...(owner !== "native"
				? { additionalExtensionPaths: ["builtin:mcp"] }
				: {}),
			extensionFactories: [
				{
					name: "faux",
					factory: (pi) => {
						pi.registerProvider("faux", {
							name: "Faux",
							api: faux.api,
							baseUrl: "http://127.0.0.1:0",
							apiKey: "test",
							models: faux.models,
							streamSimple: faux.streamSimple,
						} as never);
						pi.on("session_start", () => {
							commands = pi.getCommands().map((command) => command.name);
						});
					},
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			await session.bindExtensions({
				mode: "json",
				shutdownHandler: () => undefined,
			} as never);
			await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
			let reader: string | undefined;
			const read = (file: string): JsonObject =>
				reader!.endsWith("localFetch")
					? { path: file, ranges: ["1-10"] }
					: { path: file, startLine: 1, endLine: 10, minify: "none" };
			let result = "";
			faux.setResponses([
				(context) => {
					reader = session
						.getActiveToolNames()
						.find((name) =>
							/^mcp__octocode__(localFetch|localGetFileContent)$/.test(name),
						);
					expect(reader).toBeDefined();
					expect(commands).toContain("collision");
					expect(commands).not.toContain("model-only");
					expect(commands).not.toContain("skill:model-only");
					const user = JSON.stringify(
						context.messages
							.filter((message) => message.role === "user")
							.at(-1),
					);
					expect(user).toContain("BODY_loser");
					expect(user).not.toContain("BODY_winner");
					expect(user).not.toContain("BODY_model-only");
					expect(getCurrentSystemPrompt(context.messages)).toContain(
						"<name>model-only</name>",
					);
					return fauxAssistantMessage(
						[
							fauxToolCall(reader!, {
								queries: [
									read(path.join(loser, "reference.md")),
									read(path.join(modelOnly, "reference.md")),
									read(path.join(winner, "reference.md")),
								],
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					result = JSON.stringify(
						context.messages
							.filter((message) => message.role === "toolResult")
							.at(-1),
					);
					return fauxAssistantMessage("Read complete");
				},
			]);
			await session.prompt(
				`Use [$collision](${path.join(loser, "SKILL.md")}) and $model-only`,
			);
			if (owner === "configured-explicit") {
				expect(result).toMatch(
					/outsideAllowedRoots|outside allowed directories/,
				);
				for (const name of ["loser", "model-only", "winner"])
					expect(result).not.toContain(`REFERENCE_${name}`);
			} else {
				for (const name of ["loser", "model-only", "winner"])
					expect(result).toContain(`REFERENCE_${name}`);
				expect(result).not.toMatch(
					/outsideAllowedRoots|outside allowed directories|isError":true/,
				);
			}
			for (const blockedPath of [unrelated, path.join(loser, "escape.txt")]) {
				let blocked = "";
				faux.setResponses([
					() =>
						fauxAssistantMessage(
							[fauxToolCall(reader!, { queries: [read(blockedPath)] })],
							{ stopReason: "toolUse" },
						),
					(context) => {
						blocked = JSON.stringify(
							context.messages
								.filter((message) => message.role === "toolResult")
								.at(-1),
						);
						return fauxAssistantMessage("Blocked");
					},
				]);
				await session.prompt("Check this unrelated path.");
				expect(blocked).toMatch(
					/outsideAllowedRoots|outside allowed directories/,
				);
				expect(blocked).not.toContain("UNRELATED_SECRET");
			}
		} finally {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
		}
	},
	60_000,
);
