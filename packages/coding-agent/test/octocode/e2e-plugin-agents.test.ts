import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp, trustFolder } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const PROMPT = "PLUGIN_REVIEWER_PROMPT_MARKER";
const AGENT = `---\nname: reviewer\ndescription: Reviews code\nhooks:\n  PreToolUse: []\n---\n${PROMPT}\n`;

type Where = "user" | "project-trusted" | "project-untrusted";

/**
 * A real parent session with a scripted model, the real `agent` tool and a real child process whose provider is a local
 * server that records its requests. The `fixture` Claude plugin ships `agents/reviewer.md`.
 */
async function fixture(where: Where) {
	const root = tmp("plugin-agents-e2e-");
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	const requests: JsonObject[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			`data: ${JSON.stringify({ id: "child", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "CHILD_COMPLETE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "fixture",
							name: "Fixture",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	for (const [key, value] of Object.entries({
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_MCP: "1",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_SUBAGENT: "0",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT_LINGER_SECONDS: "0",
	}))
		vi.stubEnv(key, value);

	// The plugin lives outside the project for a user entry and inside it for a project entry.
	const plugin = path.join(where === "user" ? root : cwd, "fixture");
	fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
	fs.mkdirSync(path.join(plugin, "agents"));
	fs.writeFileSync(path.join(plugin, "agents", "reviewer.md"), AGENT);
	const entry = { path: plugin, protocol: "claude" as const };
	if (where !== "project-untrusted") trustFolder(cwd);
	let settingsManager: SettingsManager;
	if (where === "user") settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, plugins: [entry] });
	else {
		// A committed project settings file: it counts only when the user trusted the folder.
		fs.mkdirSync(path.join(cwd, ".octocode"));
		fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), JSON.stringify({ plugins: [entry] }));
		settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: where === "project-trusted" });
	}

	const faux = createFauxCore({
		provider: "faux-parent",
		models: [{ id: "parent", contextWindow: 200000, maxTokens: 4096 }],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		disabledFeatures: ["mcp", "llama.cpp"],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{
				name: "parent-fixture",
				factory: (api) =>
					api.registerProvider("faux-parent", {
						name: "Fixture parent",
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
	const { session } = await createTestSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(root, "parent-sessions")),
	});
	await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux-parent", "parent")!);
	return {
		requests,
		spawn: async (profile: string) => {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("agent", {
							reason: "Delegate the review",
							type: "task",
							profile,
							goal: "Review the change",
							task: "Review the change and report.",
							model: "fixture-local/fixture",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("PARENT_COMPLETE"),
			]);
			await session.prompt("Delegate the review.");
			const result = session.messages.findLast((message) => message.role === "toolResult");
			expect(result?.role).toBe("toolResult");
			if (result?.role !== "toolResult") return undefined;
			const text = JSON.stringify(result.content);
			// A child that failed to start: show its stderr, which the result only points to.
			const stderr = /Full stderr: ([^\\]+)/.exec(text)?.[1];
			return {
				isError: result.isError,
				text: stderr && fs.existsSync(stderr) ? `${text}\n${fs.readFileSync(stderr, "utf8")}` : text,
			};
		},
		close: async () => {
			await session.abort("shutdown");
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

it("spawns fixture:reviewer through the agent tool, and the child gets the plugin profile's prompt", async () => {
	const f = await fixture("user");
	try {
		const result = await f.spawn("fixture:reviewer");
		expect(result?.isError, result?.text).toBe(false);
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests[0])).toContain(PROMPT);
	} finally {
		await f.close();
	}
}, 60000);

it("loads the agents of a project-scope plugin in a trusted folder", async () => {
	const f = await fixture("project-trusted");
	try {
		const result = await f.spawn("fixture:reviewer");
		expect(result?.isError, result?.text).toBe(false);
		expect(JSON.stringify(f.requests[0])).toContain(PROMPT);
	} finally {
		await f.close();
	}
}, 60000);

it("contributes no agent from a project-scope plugin in an untrusted folder", async () => {
	const f = await fixture("project-untrusted");
	try {
		const result = await f.spawn("fixture:reviewer");
		expect(result?.isError).toBe(true);
		expect(result?.text).toMatch(/Unknown profile \\"fixture:reviewer\\"\. Available: [^"]*/);
		expect(result?.text).not.toMatch(/Available: [^"]*fixture:reviewer/);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 60000);
