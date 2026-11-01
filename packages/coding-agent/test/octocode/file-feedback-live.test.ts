import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/**
 * Edit feedback through the real Octocode MCP server and the host's nested tool calls, not stubbed results: the
 * server answers with workspace-relative row paths and no envelope root, which the stubbed suite never exercised.
 */
it("reports parser regressions and LSP issues after native file edits through live Octocode MCP", async () => {
	const root = tmp("file-feedback-live-");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.writeFileSync(
		path.join(cwd, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
	);
	const source = path.join(cwd, "source.ts");
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
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
	});
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: true,
		additionalExtensionPaths: ["builtin:mcp"],
		extensionFactories: [
			{
				name: "faux",
				factory: (api) =>
					api.registerProvider("faux", {
						name: "Faux",
						api: faux.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: faux.models,
						streamSimple: faux.streamSimple,
					} as never),
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
	/** Run one tool call as the model and return the text of its result. */
	const call = async (name: string, args: JsonObject): Promise<string> => {
		let text = "";
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
				text = JSON.stringify(result?.content ?? []);
				return fauxAssistantMessage("ok");
			},
		]);
		await session.prompt(`Run ${name}`);
		return text;
	};
	const edit = (oldText: string, newText: string) =>
		call("file", {
			reason: "Edit the fixture source",
			queries: [{ type: "edit", path: source, reason: "fixture", edits: [{ oldText, newText }] }],
		});
	try {
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
		await call("file", {
			reason: "Write the fixture source",
			queries: [{ type: "write", path: source, reason: "fixture", content: "export const value: number = 1;\n" }],
		});
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["file", "mcp__octocode__astSearch", "mcp__octocode__lspSearch"]),
		);
		// Warm the language server outside the feedback budget; a cold start legitimately reports `pending`.
		await call("mcp__octocode__lspSearch", { queries: [{ operation: "diagnostic", path: source }] });

		const typeError = await edit("= 1;", '= "one";');
		expect(typeError).toMatch(/diagnostics observed after edit[^"]*2322/);
		expect(typeError).not.toContain("parse completed");

		const syntaxError = await edit('= "one";', '= "one";\nexport function broken( {\n');
		expect(syntaxError).toContain("possible parse regression observed after edit");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}, 90_000);
