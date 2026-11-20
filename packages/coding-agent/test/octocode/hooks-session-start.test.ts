import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { registerMcpHookCaller } from "../../../mcp/src/hook-caller.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { resumeFields } from "../../src/octocode/hooks/register/resume-fields.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
it.each(["claude", "codex", "octocode"] as const)("preserves %s fork source semantics", async (protocol) => {
	const home = tmp();
	const native = tmp();
	vi.stubEnv("OCTOCODE_HOME", native);
	const file =
		protocol === "octocode"
			? path.join(native, "hooks.json")
			: path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const source = protocol === "octocode" ? "resume" : "fork";
	fs.writeFileSync(
		file,
		JSON.stringify({
			hooks: { SessionStart: [{ matcher: source, hooks: [{ type: "command", command: "echo source-matched" }] }] },
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, { env: {}, home });
	await fake.fire("session_start", { reason: "fork" }, ctx);
	const results = await fake.emit("before_agent_start", {}, ctx);
	expect(JSON.stringify(results)).toContain("source-matched");
});

it("delivers compact and clear MCP context once through the registered owner", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "policy", tool: "context" }] }] } }),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	Object.assign(fake.api, { channels: createEventBus() });
	const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "MCP session guidance" }] }));
	const unregister = registerMcpHookCaller(fake.api.channels, call);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, { env: {}, home });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).not.toContain("MCP session guidance");
	expect(call).not.toHaveBeenCalled();
	for (const event of ["session_compact", "session_start"] as const) {
		await fake.fire(event, { reason: "new" }, ctx);
		expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).toContain("MCP session guidance");
		expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).not.toContain("MCP session guidance");
	}
	expect(call).toHaveBeenCalledTimes(2);
	unregister();
	await fake.fire("session_shutdown", {}, ctx);
});

it.each(["claude", "codex"] as const)(
	"delivers the active model through the %s SessionStart owner",
	async (protocol) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		const file = path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "mcp_tool", server: "policy", tool: "context", input: { model: "${model}" } }] },
					],
				},
			}),
		);
		const fake = fakeHost(HOOK_SETTINGS);
		Object.assign(fake.api, { channels: createEventBus() });
		const call = vi.fn(async () => ({ content: [] }));
		const unregister = registerMcpHookCaller(fake.api.channels, call);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false, model: { id: "fixture-model" } });
		registerHooks(fake.api, { env: {}, home });
		try {
			await fake.fire("session_start", { reason: protocol === "claude" ? "new" : "startup" }, ctx);
			await fake.emit("before_agent_start", {}, ctx);
			expect(call).toHaveBeenCalledWith(expect.objectContaining({ input: { model: "fixture-model" } }));
		} finally {
			unregister();
			await fake.fire("session_shutdown", {}, ctx);
		}
	},
);

describe("SessionStart resume fields", () => {
	const model = {
		provider: "anthropic",
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
	const now = Date.parse("2026-11-19T12:00:00Z");
	const reply = (ago: number) => ({
		type: "message",
		message: {
			role: "assistant",
			timestamp: now - ago * 1000,
			usage: { input: 340, output: 2000, cacheRead: 180_000, cacheWrite: 0, totalTokens: 182_340, cost: { total: 0 } },
		},
	});
	const ctx = (branch: unknown[]) => {
		const base = fakeCtx({ cwd: tmp(), hasUI: false, model });
		return { ...base, sessionManager: { ...base.sessionManager, getBranch: () => branch } } as never;
	};

	it("says how old the last reply is, what the first request re-sends, and whether its cache entry is gone", () => {
		const old = resumeFields({}, ctx([reply(5400)]), now);
		expect(old).toMatchObject({
			seconds_since_last_response: 5400,
			context_tokens: 182_340,
			prompt_cache_likely_expired: true,
		});
		// Writing 182,340 tokens costs at least the 5-minute write price.
		expect(old?.estimated_cache_write_usd).toBeGreaterThanOrEqual(1.1396);
		expect(resumeFields({}, ctx([reply(10)]), now)?.prompt_cache_likely_expired).toBe(false);
		// A compaction after the reply replaced the cached conversation.
		expect(resumeFields({}, ctx([reply(10), { type: "compaction" }]), now)?.prompt_cache_likely_expired).toBe(true);
		expect(resumeFields({}, ctx([{ type: "message", message: { role: "user" } }]), now)).toBeUndefined();
	});

	it("sends them to a resumed session's hooks and to no other start", async () => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		const capture = path.join(tmp(), "payloads.jsonl");
		const script = path.join(tmp(), "hook.cjs");
		fs.writeFileSync(
			script,
			`let s=''; process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(JSON.parse(s))+'\\n');});`,
		);
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(
			path.join(home, ".claude/settings.json"),
			JSON.stringify({
				hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
			}),
		);
		const fake = fakeHost(HOOK_SETTINGS);
		registerHooks(fake.api, { env: {}, home });
		const resumed = ctx([reply(60)]);
		for (const reason of ["startup", "resume"]) {
			await fake.fire("session_start", { reason }, resumed);
			await fake.emit("before_agent_start", {}, resumed);
		}
		const [startup, resume] = fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(startup).toMatchObject({ source: "startup" });
		expect(startup).not.toHaveProperty("seconds_since_last_response");
		expect(resume).toMatchObject({ source: "resume", context_tokens: 182_340 });
		expect(resume.seconds_since_last_response).toBeGreaterThanOrEqual(60);
		await fake.fire("session_shutdown", {}, resumed);
	});
});
