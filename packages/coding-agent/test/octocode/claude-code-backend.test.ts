import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, type Message, normalizeContext } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adapterEnv,
	claudeCodeLaunch,
	claudeCodePermission,
	sessionMeta,
} from "../../src/octocode/claude-code/launch.ts";
import { CLAUDE_CODE_MODELS } from "../../src/octocode/claude-code/models.ts";
import { createClaudeCodeBackend } from "../../src/octocode/claude-code/provider.ts";
import { registerClaudeCode } from "../../src/octocode/claude-code/register.ts";
import { appendedPrompt, CALL_PREFIX, promptText, unseen } from "../../src/octocode/claude-code/transcript.ts";
import type { RunnerState } from "../../src/octocode/external/runner-status.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const PEER = fileURLToPath(new URL("./fixtures/claude-code-peer.mjs", import.meta.url));

afterEach(() => vi.unstubAllEnvs());

/** A PATH holding stand-ins for `claude` and its ACP adapter. */
function binaries(names = ["claude", "claude-agent-acp"]) {
	const bin = tmp("octocode-claude-code-bin-");
	for (const name of names) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return bin;
}

const state = (auth: RunnerState["auth"], adapter = true): RunnerState => ({
	id: "claude-code",
	name: "Claude Code",
	cli: true,
	adapter,
	version: "2.1.322",
	...(auth ? { auth } : {}),
	checkedAt: 1,
});

const PLAN = { signedIn: true, method: "claude.ai", billing: "plan" as const };

describe("when the claude-code models are offered", () => {
	it("launches the installed adapter for the user's own claude when Claude Code is connected on its plan", () => {
		const bin = binaries();
		expect(claudeCodeLaunch([state(PLAN)], { PATH: bin })).toEqual({
			command: path.join(bin, "claude-agent-acp"),
			args: [],
			cli: path.join(bin, "claude"),
		});
	});

	it("offers nothing when Claude Code is signed out, metered, unchecked or missing its adapter", () => {
		const bin = binaries();
		expect(claudeCodeLaunch([state({ signedIn: false })], { PATH: bin })).toBeUndefined();
		expect(claudeCodeLaunch([state({ ...PLAN, billing: "metered" })], { PATH: bin })).toBeUndefined();
		expect(claudeCodeLaunch([state({ signedIn: true, method: "unclassified" })], { PATH: bin })).toBeUndefined();
		expect(claudeCodeLaunch([state(undefined)], { PATH: bin })).toBeUndefined();
		expect(claudeCodeLaunch([state(PLAN, false)], { PATH: bin })).toBeUndefined();
		expect(claudeCodeLaunch([state(PLAN)], { PATH: binaries(["claude"]) })).toBeUndefined();
		expect(claudeCodeLaunch([], { PATH: bin })).toBeUndefined();
	});

	it("registers the provider, billed by plan through the CLI, only for a connected runner", () => {
		vi.stubEnv("PATH", binaries());
		const host = fakeHost();
		const registered: unknown[] = [];
		const api = { ...host.api, registerProvider: (provider: unknown) => registered.push(provider) } as never;
		registerClaudeCode(api, []);
		expect(registered).toEqual([]);
		registerClaudeCode(api, [state(PLAN)]);
		expect(registered).toEqual([
			expect.objectContaining({
				id: "claude-code",
				auth: expect.objectContaining({ plan: expect.objectContaining({ billing: "plan", transport: "cli" }) }),
			}),
		]);
		expect(CLAUDE_CODE_MODELS.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"claude-code/opus",
			"claude-code/sonnet",
			"claude-code/haiku",
		]);
	});
});

describe("Claude Code's process and session", () => {
	it("starts without provider keys, with the user's claude, the model alias and every tool declared up front", () => {
		const env = adapterEnv({ command: "/bin/acp", args: [], cli: "/home/me/.local/bin/claude" }, "sonnet", {
			PATH: "/bin",
			HOME: "/home/me",
			ANTHROPIC_API_KEY: "sk-ant-api03-x",
			ANTHROPIC_AUTH_TOKEN: "x",
			OPENAI_API_KEY: "sk-x",
			CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
		});
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/me",
			CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
			CLAUDE_CODE_EXECUTABLE: "/home/me/.local/bin/claude",
			ANTHROPIC_MODEL: "sonnet",
			ENABLE_TOOL_SEARCH: "false",
		});
	});

	it("turns Claude Code's own tools, settings and MCP servers off and appends only Octocode's short instruction", () => {
		expect(sessionMeta("note")).toEqual({
			systemPrompt: { append: "note" },
			claudeCode: {
				options: { tools: [], allowedTools: ["mcp__octocode"], settingSources: [], strictMcpConfig: true },
			},
		});
		const withProject = appendedPrompt(
			normalizeContext({ systemPrompt: "", messages: [] }).messages.concat({
				role: "system",
				content: "",
				sections: { project_context: "<project_instructions>Run yarn test.</project_instructions>" },
				timestamp: 0,
			}),
		);
		expect(withProject).toMatch(/^You are working inside Octocode/);
		expect(withProject).toContain(
			"<project_context>\n<project_instructions>Run yarn test.</project_instructions>\n</project_context>",
		);
		expect(appendedPrompt([])).not.toContain("project_context");
	});

	it("allows Claude Code's request for an Octocode tool and refuses any other", async () => {
		const options = [
			{ optionId: "yes", name: "Allow", kind: "allow_once" as const },
			{ optionId: "no", name: "Deny", kind: "reject_once" as const },
		];
		const ask = (title: string) =>
			claudeCodePermission(
				{ sessionId: "s", toolCall: { toolCallId: "t", title }, options },
				new AbortController().signal,
			);
		expect(await ask("mcp__octocode__bash")).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
		expect(await ask("Bash")).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
	});
});

const user = (text: string, timestamp = 1): Message => ({ role: "user", content: text, timestamp });
const turn = (
	responseId: string,
	content: AssistantMessage["content"],
	provider = "claude-code",
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "claude-code-acp",
	provider,
	model: "opus",
	responseId,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
});

describe("what Claude Code is sent", () => {
	it("sends only the messages after its last turn, without the results it already received", () => {
		const messages: Message[] = [
			user("first"),
			turn("acp-1", [{ type: "toolCall", id: `${CALL_PREFIX}a`, name: "bash", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: `${CALL_PREFIX}a`,
				toolName: "bash",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 3,
			},
			user("and then?"),
		];
		expect(promptText(unseen(messages, "acp-1"))).toBe("and then?");
	});

	it("gives a new session the turns it never saw, nothing cut, before the new message", () => {
		const messages: Message[] = [
			user("Fix the bug"),
			turn("x", [{ type: "text", text: "Fixed in app.ts" }], "anthropic"),
			user("Now add a test"),
		];
		const text = promptText(unseen(messages, undefined));
		expect(text).toContain("<octocode_history>");
		expect(text).toContain("[user]\nFix the bug");
		expect(text).toContain("[assistant]\nFixed in app.ts");
		expect(text.endsWith("</octocode_history>\n\nNow add a test")).toBe(true);
	});
});

describe("a request that is not the agent loop's turn", () => {
	it("runs once in a session of its own, without tools, and stops its adapter, even with the session's id", async () => {
		const journal = path.join(tmp("octocode-claude-code-oneshot-"), "journal.jsonl");
		const backend = createClaudeCodeBackend({
			command: process.execPath,
			args: [PEER, journal, JSON.stringify({ prompts: [[{ say: "Summary: fixed the bug." }]] })],
			cli: "/usr/bin/false",
		});
		// A compaction summary shares the session's id for its cache, but the loop did not mark it as a turn.
		await backend.bind("session-1", tmp("octocode-claude-code-cwd-"));
		const context = normalizeContext({ systemPrompt: "Summarize.", messages: [user("Summarize this session")] });
		const reply = await backend.provider
			.streamSimple(CLAUDE_CODE_MODELS[0], context, { sessionId: "session-1" })
			.result();
		expect(reply).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Summary: fixed the bug." }] });
		const log = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(log.find((entry) => entry.event === "session").mcpServers).toEqual([]);
		const pid = log.find((entry) => entry.event === "start").pid as number;
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let tries = 0; tries < 250 && alive(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(alive()).toBe(false);
	});
});
