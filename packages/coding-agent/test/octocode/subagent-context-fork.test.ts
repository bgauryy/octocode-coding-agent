import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { forkedContext, writeForkedSession } from "../../src/octocode/subagents/context-fork.ts";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import { type Fixture, fixture } from "./agent-context/capture.ts";
import { assign, runChild } from "./agent-context/child-run.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * `context: "fork"`: a child starts from a frozen copy of the parent's model-visible branch, then lives its own
 * conversation. Real child sessions on a scripted model (`agent-context/child-run.ts`); each claim is about what the
 * child's provider requests and saved file hold.
 */

const OFF_BRANCH = "OFF-BRANCH-SENTINEL";
const PRIVATE = "PRIVATE-SENTINEL";
const HIDDEN_SHELL = "HIDDEN-SHELL-SENTINEL";
const UNFINISHED = "UNFINISHED-CALL-SENTINEL";
const SENTINELS = [OFF_BRANCH, PRIVATE, HIDDEN_SHELL, UNFINISHED];

/** A parent session whose active branch holds visible turns, a finished tool call, and every kind of excluded record. */
function parentSession(cwd: string) {
	const parent = SessionManager.inMemory(cwd);
	const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
	parent.appendMessage(user("VISIBLE-USER"));
	const paid = fauxAssistantMessage(
		[fauxText("VISIBLE-CALL"), fauxToolCall("read", { path: "a.ts" }, { id: "done-1" })],
		{ stopReason: "toolUse" },
	);
	paid.usage = { ...emptyUsage(), input: 900, totalTokens: 900, cost: { ...emptyUsage().cost, total: 0.5 } };
	const first = parent.appendMessage(paid);
	parent.appendMessage({
		role: "toolResult",
		toolCallId: "done-1",
		toolName: "read",
		content: [{ type: "text", text: "FINISHED-RESULT" }],
		isError: false,
		timestamp: Date.now(),
	});
	parent.appendMessage(fauxAssistantMessage("VISIBLE-ANSWER"));
	const answered = parent.getLeafId()!;
	parent.appendMessage(user(OFF_BRANCH));
	parent.branch(first);
	parent.branch(answered);
	parent.appendCustomMessageEntry("note", PRIVATE, "only");
	parent.appendMessage({
		role: "bashExecution",
		command: "echo",
		output: HIDDEN_SHELL,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: Date.now(),
	});
	parent.appendMessage(user("VISIBLE-FOLLOWUP"));
	parent.appendMessage(
		fauxAssistantMessage(
			[fauxText("VISIBLE-LEAD-IN"), fauxToolCall("agent", { task: UNFINISHED }, { id: "pending-1" })],
			{ stopReason: "toolUse" },
		),
	);
	return parent;
}

describe("agent task context: fork", () => {
	let fx: Fixture | undefined;
	afterEach(() => {
		if (fx) fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		fx = undefined;
	});

	const identity = (f: Fixture): Identity =>
		({
			id: "child-example",
			role: "implementer",
			parentId: "parent-example",
			parentSession: "parent-session-example",
			scratch: f.scratch,
			permission: { mode: "workspace", grants: [] },
			goal: "continue the work",
			background: true,
		}) as Identity;

	it("starts the child from the parent's visible branch only, and the child resumes its own conversation", async () => {
		fx = fixture();
		const parent = parentSession(fx.cwd);
		const frozen = forkedContext({ context: "fork" }, parent)!;
		const child = { dir: path.join(fx.scratch, "session"), id: "child-example" };
		const file = writeForkedSession(child, fx.cwd, parent.getSessionId(), frozen);
		const run = assign(identity(fx), "Take it from here.");

		const first = await runChild(fx, run.identity, [{ prompt: run.task, reply: "CHILD-REPLY" }], child.dir, file);
		const texts = first.requests[0].texts.join("\n");
		for (const visible of [
			"VISIBLE-USER",
			"VISIBLE-CALL",
			"FINISHED-RESULT",
			"VISIBLE-ANSWER",
			"VISIBLE-FOLLOWUP",
			"VISIBLE-LEAD-IN",
		])
			expect(texts).toContain(visible);
		expect(texts).toContain("Take it from here.");
		for (const hidden of SENTINELS) expect(texts).not.toContain(hidden);
		// Nothing of an excluded record is saved in the child's own file either, nor the unfinished call's arguments.
		const saved = fs.readFileSync(first.file, "utf8");
		for (const hidden of SENTINELS) expect(saved).not.toContain(hidden);
		expect(saved).not.toContain("pending-1");
		// The child has its own identity and prompt, and the copied turns carry none of the parent's spend.
		expect(first.file).toBe(file);
		expect(first.requests[0].system).not.toBe("null");
		const copied = first.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		expect(copied.length).toBeGreaterThan(2);
		for (const message of copied.slice(0, -1)) expect(message.usage.totalTokens).toBe(0);
		for (const message of copied.slice(0, -1)) expect(message.usage.cost.total).toBe(0);

		// The parent moves on; the child's resume reopens its own file and continues its own conversation.
		parent.appendMessage({ role: "user", content: "PARENT-LATER-SENTINEL", timestamp: Date.now() });
		const resumed = await runChild(
			fx,
			run.identity,
			[{ prompt: "Continue.", reply: "CHILD-TWO" }],
			child.dir,
			first.file,
		);
		const again = resumed.requests[0].texts.join("\n");
		expect(again).toContain("CHILD-REPLY");
		expect(again).toContain("VISIBLE-ANSWER");
		expect(again).toContain("Continue.");
		expect(again).not.toContain("PARENT-LATER-SENTINEL");
		expect(resumed.file).toBe(file);
	});

	it("leaves a call without context a fresh session, and refuses a fork a resume or runner cannot take", () => {
		fx = fixture();
		const parent = parentSession(fx.cwd);
		expect(forkedContext({}, parent)).toBeUndefined();
		expect(() => forkedContext({ context: "fork", resume: "researcher-1" }, parent)).toThrow(/resume and runner/);
		expect(() => forkedContext({ context: "fork", runner: "claude" }, parent)).toThrow(/resume and runner/);
	});

	it("never overwrites a session file that exists", () => {
		fx = fixture();
		const child = { dir: path.join(fx.scratch, "session"), id: "child-example" };
		const at = 1_700_000_000_000;
		const cwd = fx.cwd;
		writeForkedSession(child, cwd, "parent", [], at);
		expect(() => writeForkedSession(child, cwd, "parent", [], at)).toThrow(/EEXIST/);
	});
});

describe("agent tool with context: fork and a scripted child", () => {
	const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
	const savedArgv = process.argv[1];
	const savedEnv = { ...process.env };
	beforeAll(() => {
		const root = tmp("octocode-agent-fork-");
		process.env.OCTOCODE_HOME = path.join(root, "home");
		process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
		for (const key of ["OCTOCODE_SUBAGENT", "OCTOCODE_AGENT_ID", "OCTOCODE_PARENT_ID", "OCTOCODE_AGENT_GOAL"])
			delete process.env[key];
		// runSubagent re-runs the current `octocode` script: point it at the scripted stand-in.
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
		process.argv[1] = path.join(bin, "octocode");
	});
	afterAll(() => {
		process.argv[1] = savedArgv!;
		process.env = savedEnv;
	});

	function setup() {
		const f = fakeHost();
		const team = new Team(f.api);
		const control = registerAgentTool(f.api, {
			profiles: () => new Map(),
			team,
			permission: fakePermission(),
			refused: () => new Map(),
		});
		const cwd = tmp("octocode-agent-fork-cwd-");
		const ctx = fakeCtx({ cwd, hasUI: true });
		const models = [{ provider: "faux", id: "model", reasoning: true }];
		Object.assign(ctx, {
			model: models[0],
			sessionManager: parentSession(cwd),
			modelRegistry: {
				...meteredBilling,
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
				getCachePolicy: fakeCachePolicy,
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			},
		});
		team.start(ctx);
		const agent = f.tools.get("agent");
		const run = (params: Record<string, unknown>) =>
			agent.execute("call-1", { goal: "check things", ...params }, undefined, undefined, ctx);
		return { ...f, run, control };
	}

	/** What the child's session file holds when it starts: the conversation its first model request is built from. */
	const startFile = (dir: string) => {
		const [name] = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		return fs.readFileSync(path.join(dir, name), "utf8");
	};
	const expectFork = (saved: string) => {
		expect(saved).toContain("VISIBLE-USER");
		expect(saved).toContain("VISIBLE-FOLLOWUP");
		for (const hidden of SENTINELS) expect(saved).not.toContain(hidden);
		expect(saved).not.toContain("pending-1");
	};

	it("starts a foreground child from the parent's visible branch, and a call without context from none of it", async () => {
		const s = setup();
		const forked = await s.run({ task: "report back", context: "fork" });
		expect(forked.isError).toBeUndefined();
		expectFork(startFile(forked.details.session.dir));
		const fresh = await s.run({ task: "report back" });
		expect(fresh.isError).toBeUndefined();
		const saved = startFile(fresh.details.session.dir);
		for (const text of ["VISIBLE-USER", "VISIBLE-ANSWER", "VISIBLE-FOLLOWUP", ...SENTINELS])
			expect(saved).not.toContain(text);
	}, 30_000);

	it("freezes a queued background child's context at dispatch, before its slot frees", async () => {
		const s = setup();
		const gate = path.join(tmp("octocode-agent-fork-gate-"), "open");
		const first = await s.run({ task: `chain gate ${gate}`, background: true });
		const queued = await s.run({
			task: "report back",
			context: "fork",
			background: true,
			after: [`agent:${first.details.id}`],
		});
		expect(queued.details).toMatchObject({ status: "background", queued: true });
		fs.writeFileSync(gate, "");
		await s.control.settle();
		const report = s.sent.find((entry) => entry.message.details?.id === queued.details.id);
		expect(report).toBeDefined();
		expectFork(startFile(report!.message.details.session.dir));
	}, 30_000);
});

// The child process is the scripted stand-in the harness copies to `process.argv[1]`.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
