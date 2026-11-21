import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ToolResultMessage } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createClaudeCodeBackend } from "../../src/octocode/claude-code/provider.ts";
import { attachBackend } from "../../src/octocode/claude-code/register.ts";
import { NEEDS_APPROVAL } from "../../src/octocode/permission/ask/text.ts";
import { createTestSession } from "../helpers/session.ts";
import { resetOctocodeEnv, tmp, trustFolder } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * Claude Code as the model of a real headless Octocode session, played by a scripted ACP peer that calls back into the
 * MCP server Octocode serves it, as claude-agent-acp does. No network and no vendor CLI.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(HERE, "fixtures", "claude-code-peer.mjs");
const octocode = (await import(path.join(HERE, "..", "..", "src", "index.ts"))).default as FeatureRegister;

const savedEnv = { ...process.env };
const sessions: Array<{ dispose(): void }> = [];

type Step = Record<string, unknown>;
type Entry = Record<string, unknown> & { event: string };

/** A headless Octocode session in a fresh repository whose `claude-code` models are the scripted peer. */
async function claudeCodeSession(env: Record<string, string>, prompts: Step[][]) {
	const root = fs.realpathSync(tmp("octocode-e2e-claude-code-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), "{}");
	fs.writeFileSync(path.join(cwd, "app.ts"), "export const answer = 41;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	resetOctocodeEnv();
	Object.assign(
		process.env,
		{
			HOME: home,
			OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
			OCTOCODE_HOME: path.join(home, ".octocode"),
			OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
			OCTOCODE_MCP: "0",
			// Keys Octocode holds for its own providers: none may reach Claude Code.
			ANTHROPIC_API_KEY: "sk-ant-api03-fixture",
			OPENAI_API_KEY: "sk-fixture",
		},
		env,
	);
	fs.mkdirSync(path.join(root, "agent"), { recursive: true });
	trustFolder(cwd);

	const journal = path.join(root, "journal.jsonl");
	const backend = createClaudeCodeBackend({
		command: process.execPath,
		args: [PEER, journal, JSON.stringify({ prompts })],
		cli: path.join(root, "bin", "claude"),
	});
	const provider: FeatureRegister = (api) => attachBackend(api, backend);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: path.join(root, "agent"),
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([
			{ name: "claude-code-provider", factory: provider },
			{ name: "octocode", factory: octocode },
		]),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	sessions.push({ dispose: () => void backend.close().finally(() => session.dispose()) });
	await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("claude-code", "opus")!);
	const entries = (): Entry[] =>
		fs.existsSync(journal)
			? fs
					.readFileSync(journal, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Entry)
			: [];
	const messages = () => session.agent.state.messages;
	return { cwd, session, entries, messages };
}

const until = async (check: () => boolean, ms = 10_000) => {
	for (const started = Date.now(); !check() && Date.now() - started < ms;)
		await new Promise((resolve) => setTimeout(resolve, 20));
	expect(check()).toBe(true);
};

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
});

afterAll(() => {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

describe("Claude Code as the session's model", () => {
	it("runs Claude Code's tool call once through Octocode's loop and returns its answer, with plan usage", async () => {
		const read = { reason: "read app.ts", command: "echo ran >> ran.log && cat app.ts" };
		const { cwd, session, entries, messages } = await claudeCodeSession({ OCTOCODE_PERMISSION: "workspace" }, [
			[
				{ list: true },
				{ say: "Reading app.ts. " },
				{ call: "bash", args: read },
				{ usage: { used: 23_000, size: 200_000 } },
				{ say: "It exports 41." },
			],
			[{ say: "You're welcome." }],
		]);
		await session.prompt("What does app.ts export?");

		const log = entries();
		const start = log.find((entry) => entry.event === "start")!;
		expect(start.env).not.toContain("ANTHROPIC_API_KEY");
		expect(start.env).not.toContain("OPENAI_API_KEY");
		expect(start).toMatchObject({
			model: "opus",
			executable: expect.stringMatching(/bin\/claude$/),
			toolSearch: "false",
		});
		const opened = log.find((entry) => entry.event === "session") as Entry & {
			mcpServers: Array<{ type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
			meta: { systemPrompt: { append: string }; claudeCode: { options: Record<string, unknown> } };
		};
		expect(opened.mcpServers).toEqual([
			{
				type: "http",
				name: "octocode",
				url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
				headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer \S{40,}$/) }],
			},
		]);
		expect(opened.meta.claudeCode.options).toEqual({
			tools: [],
			allowedTools: ["mcp__octocode"],
			settingSources: [],
			strictMcpConfig: true,
			// Claude Code's own slash commands and skills stay off: Octocode's tools are the only tools.
			extraArgs: { "disable-slash-commands": null },
		});
		expect(opened.meta.systemPrompt.append).toBeTruthy();
		expect((log.find((entry) => entry.event === "tools")?.names as string[]) ?? []).toEqual(
			expect.arrayContaining(["bash", "file"]),
		);
		expect(log.find((entry) => entry.event === "prompt")).toMatchObject({ text: "What does app.ts export?" });
		expect(log.find((entry) => entry.event === "result")).toMatchObject({
			name: "bash",
			isError: false,
			text: expect.stringContaining("export const answer = 41;"),
		});
		// Ran once: by Octocode's loop, for Claude Code's one call.
		expect(fs.readFileSync(path.join(cwd, "ran.log"), "utf8")).toBe("ran\n");

		const transcript = messages();
		const replies = transcript.filter((message): message is AssistantMessage => message.role === "assistant");
		expect(replies.map((reply) => [reply.provider, reply.stopReason])).toEqual([
			["claude-code", "toolUse"],
			["claude-code", "stop"],
		]);
		expect(replies[0].content).toEqual([
			{ type: "text", text: "Reading app.ts. " },
			expect.objectContaining({ type: "toolCall", name: "bash", arguments: read }),
		]);
		const results = transcript.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(replies[1].content).toEqual([{ type: "text", text: "It exports 41." }]);
		expect(replies[1].usage).toMatchObject({
			input: 1200,
			output: 80,
			cacheRead: 22_000,
			cacheWrite: 500,
			totalTokens: 23_000,
		});
		expect(replies[1].usage.cost.total).toBe(0);

		// The next turn reuses the same Claude Code session and sends only the new message.
		await session.prompt("Thanks");
		expect(entries().filter((entry) => entry.event === "start")).toHaveLength(1);
		expect(
			entries()
				.filter((entry) => entry.event === "prompt")
				.at(-1),
		).toMatchObject({ index: 1, text: "Thanks" });
	}, 60_000);

	it("asks Octocode's permission gate for Claude Code's call: a headless manual session refuses it, and nothing runs", async () => {
		const { cwd, session, entries } = await claudeCodeSession({ OCTOCODE_PERMISSION: "manual" }, [
			[{ call: "bash", args: { reason: "write", command: "echo hi > hi.txt" } }, { say: "Blocked." }],
		]);
		await session.prompt("Write hi.txt");
		const result = entries().find((entry) => entry.event === "result")!;
		expect(result.isError).toBe(true);
		expect(String(result.text).startsWith(NEEDS_APPROVAL)).toBe(true);
		expect(fs.existsSync(path.join(cwd, "hi.txt"))).toBe(false);
	}, 60_000);

	it("stops the adapter when the user cancels, and resumes its session on the next turn", async () => {
		const { session, entries, messages } = await claudeCodeSession({ OCTOCODE_PERMISSION: "workspace" }, [
			[{ say: "Working" }, { wait: true }],
			[{ say: "Back." }],
		]);
		const running = session.prompt("Long task");
		await until(() => entries().some((entry) => entry.event === "prompt"));
		const pid = entries().find((entry) => entry.event === "start")!.pid as number;
		await session.abort();
		await running;
		await until(() => !alive(pid));
		const last = messages()
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.at(-1)!;
		expect(last.stopReason).toBe("aborted");

		await session.prompt("Continue");
		const log = entries();
		expect(log.filter((entry) => entry.event === "start")).toHaveLength(2);
		expect(log.find((entry) => entry.event === "resume")).toMatchObject({ sessionId: "peer-session-1" });
		expect(log.filter((entry) => entry.event === "prompt").at(-1)).toMatchObject({ text: "Continue" });
	}, 60_000);
});
