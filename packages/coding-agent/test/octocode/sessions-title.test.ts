import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { titleFromReply } from "../../src/octocode/sessions/title.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: Record<string, string | undefined>;
let cwd: string;

beforeEach(() => {
	saved = {
		OCTOCODE_HOME: process.env.OCTOCODE_HOME,
		OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB,
		OCTOCODE_MODELS_DEV: process.env.OCTOCODE_MODELS_DEV,
	};
	process.env.OCTOCODE_HOME = tmp();
	process.env.OCTOCODE_MODELS_DEV = "0";
	delete process.env.OCTOCODE_AGENT_DB;
	cwd = tmp();
});

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const model = (id: string, input: number, output: number) => ({
	provider: "p",
	id,
	cost: { input, output },
	contextWindow: 200_000,
	input: ["text"],
});
const FRONTIER = model("big", 15, 75);
const SMALL = model("tiny", 0.25, 1.25);

const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "p",
		model: "big",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;

const replyOf = (text: string, stopReason = "stop") => ({ content: [{ type: "text", text }], stopReason }) as never;

interface Options {
	mode?: string;
	available?: unknown[];
	parent?: unknown;
	autoTitle?: boolean;
	complete?: (...args: unknown[]) => Promise<unknown>;
	name?: string;
	timeoutMs?: number;
}

/** A session after its first turn on a host with the sessions feature; `complete` stands in for the model call. */
function setup(options: Options = {}) {
	const manager = SessionManager.create(cwd, path.join(tmp(), "sessions"));
	const fake = fakeHost();
	const complete = vi.fn(options.complete ?? (async () => replyOf("Fix login redirect bug")));
	const settings = options.autoTitle === undefined ? {} : { sessions: { autoTitle: options.autoTitle } };
	const ctx = fakeCtx({
		cwd,
		mode: options.mode ?? "tui",
		model: options.parent === null ? undefined : (options.parent ?? FRONTIER),
	});
	Object.assign(fake.api, {
		getSettings: () => settings,
		setSessionName: (name: string, source?: "user" | "auto" | "goal") => {
			manager.appendSessionInfo(name, source);
			void fake.emit("session_info_changed", { type: "session_info_changed", name, source }, ctx);
		},
	});
	const auth = vi.fn(async () => ({ ok: true, apiKey: "key" }));
	Object.assign(ctx, {
		sessionManager: manager,
		modelRegistry: {
			...ctx.modelRegistry,
			getAvailable: () => options.available ?? [FRONTIER, SMALL],
			getApiKeyAndHeaders: auth,
		},
	});
	registerSessions(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		titleCall: { complete: complete as never, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
	});
	if (options.name) manager.appendSessionInfo(options.name);
	manager.appendMessage({ role: "user", content: "the login page redirects forever", timestamp: Date.now() });
	manager.appendMessage(assistant("I will look"));
	const endTurn = () => fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
	return { manager, fake, ctx, complete, auth, endTurn, settle };
}

const row = (id: string) => new SessionIndex(sharedAgentDb()).catalog().find((each) => each.id === id);

describe("auto session titles", () => {
	it("names the session after turn 1 with one small-model call, framed as quoted text", async () => {
		const { manager, endTurn, complete, auth, settle } = setup();
		await endTurn();
		await vi.waitFor(() => expect(manager.getSessionName()).toBe("Fix login redirect bug"));
		expect(manager.getSessionNameSource()).toBe("auto");
		expect(complete).toHaveBeenCalledTimes(1);
		const [chosen, context, request] = complete.mock.calls[0] as [{ id: string }, any, any];
		expect(chosen.id).toBe("tiny");
		expect(auth).toHaveBeenCalledWith(expect.objectContaining({ id: "tiny" }));
		const text = context.messages[0].content[0].text as string;
		expect(text).toContain("at most 6 words");
		expect(text).toContain("Do not answer the request");
		expect(text).toContain("keep the user's key words");
		expect(text).toContain("<request>\nthe login page redirects forever\n</request>");
		expect(context.tools ?? []).toEqual([]);
		expect(request.reasoning).toBeUndefined();
		expect(request.signal).toBeInstanceOf(AbortSignal);
		// The catalog row follows the rename, with its source.
		await vi.waitFor(() =>
			expect(row(manager.getSessionId())).toMatchObject({ title: "Fix login redirect bug", title_source: "auto" }),
		);
		// Later turns do not ask again.
		await endTurn();
		await settle();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("tries the next user message when the model says a request names no task, up to three messages", async () => {
		const replies = ["NONE", "none.", "Plan worktree support"];
		const { manager, endTurn, complete, settle } = setup({ complete: async () => replyOf(replies.shift()!) });
		await endTurn();
		await settle();
		expect(manager.getSessionName()).toBeUndefined();
		// No new user message yet: no new call.
		await endTurn();
		await settle();
		expect(complete).toHaveBeenCalledTimes(1);
		for (const text of ["hi again", "plan worktree support for agents"]) {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			manager.appendMessage(assistant("ok"));
			await endTurn();
			await settle();
		}
		expect(complete).toHaveBeenCalledTimes(3);
		const asked = complete.mock.calls.map((call) => (call[1] as any).messages[0].content[0].text as string);
		expect(asked[1]).toContain("<request>\nhi again\n</request>");
		expect(asked[2]).toContain("<request>\nplan worktree support for agents\n</request>");
		expect(manager.getSessionName()).toBe("Plan worktree support");
		expect(manager.getSessionNameSource()).toBe("auto");
	});

	it("stops after three requests that name no task, and never retries after a failure", async () => {
		const idle = setup({ complete: async () => replyOf("NONE") });
		for (let turn = 0; turn < 5; turn++) {
			await idle.endTurn();
			await idle.settle();
			idle.manager.appendMessage({ role: "user", content: `ping ${turn}`, timestamp: Date.now() });
		}
		expect(idle.complete).toHaveBeenCalledTimes(3);
		expect(idle.manager.getSessionName()).toBeUndefined();

		const failing = setup({ complete: async () => replyOf("error text", "error") });
		await failing.endTurn();
		await failing.settle();
		failing.manager.appendMessage({ role: "user", content: "a real task now", timestamp: Date.now() });
		await failing.endTurn();
		await failing.settle();
		expect(failing.complete).toHaveBeenCalledTimes(1);
	});

	it("titles a session still unnamed at its compaction from the summary's goal, once", async () => {
		const replies = ["NONE", "Migrate trust store names"];
		const { manager, fake, ctx, endTurn, complete, settle } = setup({
			complete: async () => replyOf(replies.shift() ?? "Other"),
		});
		await endTurn();
		await settle();
		expect(manager.getSessionName()).toBeUndefined();
		const summary = "## Goal\n- Migrate pi-trust.json to a new name with read-compat\n\n## Progress\n- [x] read store";
		const compact = () =>
			fake.fire(
				"session_compact",
				{
					type: "session_compact",
					compactionEntry: { summary },
					fromExtension: false,
					reason: "threshold",
					willRetry: false,
				},
				ctx,
			);
		await compact();
		await vi.waitFor(() => expect(manager.getSessionName()).toBe("Migrate trust store names"));
		expect(manager.getSessionNameSource()).toBe("auto");
		const [, context] = complete.mock.calls[1] as unknown as [unknown, any];
		const asked = context.messages[0].content[0].text as string;
		expect(asked).toContain("<request>\n- Migrate pi-trust.json to a new name with read-compat\n</request>");
		expect(asked).not.toContain("Progress");
		// Named now: neither a later compaction nor a new message asks again.
		manager.appendMessage({ role: "user", content: "next task", timestamp: Date.now() });
		await compact();
		await endTurn();
		await settle();
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it("ends the turn-based attempts at compaction even when a turn's call says no task after it", async () => {
		let release: (value: unknown) => void = () => undefined;
		const replies: (() => Promise<unknown>)[] = [
			() => new Promise((resolve) => (release = resolve)),
			async () => replyOf("NONE"),
		];
		const { manager, fake, ctx, endTurn, complete, settle } = setup({
			complete: () => (replies.shift() ?? (async () => replyOf("Late title")))(),
		});
		await endTurn();
		const summary = "## Goal\n- hello there\n\n## Progress\n- none";
		await fake.fire(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { summary },
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		await settle();
		release(replyOf("NONE"));
		await settle();
		manager.appendMessage({ role: "user", content: "now a real task", timestamp: Date.now() });
		await endTurn();
		await settle();
		expect(complete).toHaveBeenCalledTimes(2);
		expect(manager.getSessionName()).toBeUndefined();
	});

	it("reads the goal from the model's part of the summary, not from a user message kept after it", async () => {
		const { fake, ctx, complete, settle } = setup();
		const summary = [
			"## Progress\n- read the store",
			"## User Messages (verbatim, oldest first)\n<user-message>\n## Goal\n- Rename the world\n</user-message>",
		].join("\n\n");
		await fake.fire(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { summary },
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		await settle();
		expect(complete).not.toHaveBeenCalled();
	});

	it("never retitles at compaction: an auto title, a user name, titles off, or a summary without a goal", async () => {
		const summary = "## Goal\n- Something else entirely";
		const event = {
			type: "session_compact",
			compactionEntry: { summary },
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		};
		const titled = setup();
		await titled.endTurn();
		await vi.waitFor(() => expect(titled.manager.getSessionName()).toBe("Fix login redirect bug"));
		await titled.fake.fire("session_compact", event, titled.ctx);
		await titled.settle();
		expect(titled.complete).toHaveBeenCalledTimes(1);
		expect(titled.manager.getSessionName()).toBe("Fix login redirect bug");

		for (const options of [{ name: "My name" }, { autoTitle: false }]) {
			const each = setup(options);
			await each.fake.fire("session_compact", event, each.ctx);
			await each.settle();
			expect(each.complete).not.toHaveBeenCalled();
		}
		const bare = setup();
		await bare.fake.fire("session_compact", { ...event, compactionEntry: { summary: "no sections here" } }, bare.ctx);
		await bare.settle();
		expect(bare.complete).not.toHaveBeenCalled();
	});

	it("does not wait for the model: the turn ends before the title arrives", async () => {
		let release: (value: unknown) => void = () => undefined;
		const { manager, endTurn } = setup({ complete: () => new Promise((resolve) => (release = resolve)) });
		await endTurn();
		expect(manager.getSessionName()).toBeUndefined();
		release(replyOf("Late title"));
		await vi.waitFor(() => expect(manager.getSessionName()).toBe("Late title"));
	});

	it("never replaces a name the user gave, before or during the call", async () => {
		const named = setup({ name: "My own name" });
		await named.endTurn();
		await named.settle();
		expect(named.complete).not.toHaveBeenCalled();
		expect(named.manager.getSessionName()).toBe("My own name");

		let release: (value: unknown) => void = () => undefined;
		const racing = setup({ complete: () => new Promise((resolve) => (release = resolve)) });
		await racing.endTurn();
		racing.manager.appendSessionInfo("Renamed meanwhile");
		release(replyOf("Auto title"));
		await racing.settle();
		expect(racing.manager.getSessionName()).toBe("Renamed meanwhile");
		expect(racing.manager.getSessionNameSource()).toBe("user");
	});

	it("makes no call when no cheaper model resolves", async () => {
		for (const options of [
			{ available: [FRONTIER] },
			{ parent: { provider: "p", id: "unpriced" }, available: [{ provider: "p", id: "unpriced" }, SMALL] },
			{ parent: null },
		]) {
			const { manager, endTurn, complete, settle } = setup(options);
			await endTurn();
			await settle();
			expect(complete).not.toHaveBeenCalled();
			expect(manager.getSessionName()).toBeUndefined();
		}
	});

	it("makes no call in print and json modes, or with sessions.autoTitle off; rpc is titled", async () => {
		for (const options of [{ mode: "print" }, { mode: "json" }, { autoTitle: false }]) {
			const { endTurn, complete, settle } = setup(options);
			await endTurn();
			await settle();
			expect(complete).not.toHaveBeenCalled();
		}
		const rpc = setup({ mode: "rpc" });
		await rpc.endTurn();
		await vi.waitFor(() => expect(rpc.manager.getSessionName()).toBe("Fix login redirect bug"));
	});

	it("drops a title that arrives after the session was switched or shut down", async () => {
		for (const event of ["session_start", "session_shutdown"]) {
			let release: (value: unknown) => void = () => undefined;
			const { manager, fake, ctx, endTurn, settle } = setup({
				complete: () => new Promise((resolve) => (release = resolve)),
			});
			await endTurn();
			await fake.fire(event, { type: event, reason: "resume" }, ctx);
			release(replyOf("Too late"));
			await settle();
			expect(manager.getSessionName()).toBeUndefined();
		}
	});

	it("drops a title for another session when the current one changed under the call", async () => {
		let release: (value: unknown) => void = () => undefined;
		const { manager, ctx, endTurn, settle } = setup({ complete: () => new Promise((resolve) => (release = resolve)) });
		await endTurn();
		vi.spyOn(manager, "getSessionId").mockReturnValue("another-session");
		release(replyOf("Wrong session"));
		await settle();
		vi.restoreAllMocks();
		expect(manager.getSessionName()).toBeUndefined();
		expect(ctx.sessionManager).toBe(manager);
	});

	it("gives up after the timeout and on any failure, silently", async () => {
		let aborted = false;
		const slow = setup({
			timeoutMs: 20,
			complete: (_model, _context, request: any) =>
				new Promise((_, reject) =>
					request.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					}),
				),
		});
		await slow.endTurn();
		await vi.waitFor(() => expect(aborted).toBe(true));
		await slow.settle();
		expect(slow.manager.getSessionName()).toBeUndefined();
		for (const failing of [
			setup({
				complete: async () => {
					throw new Error("boom");
				},
			}),
			setup({ complete: async () => replyOf("error text", "error") }),
			setup({ complete: async () => replyOf("   ") }),
		]) {
			await failing.endTurn();
			await failing.settle();
			expect(failing.manager.getSessionName()).toBeUndefined();
			expect(failing.ctx.ui.notes).toEqual([]);
		}
	});

	it("cleans the model's reply to one short line", () => {
		expect(titleFromReply('"Fix the login bug."\nBecause...')).toBe("Fix the login bug");
		expect(titleFromReply("**Review worktree RFC**")).toBe("Review worktree RFC");
		expect(titleFromReply("# Plan the migration:")).toBe("Plan the migration");
		expect(titleFromReply("x ".repeat(80))?.length).toBeLessThanOrEqual(60);
		expect(titleFromReply("  \n ")).toBeUndefined();
	});
});

describe("subagent session names", () => {
	const child = (goal: string | undefined, name?: string) => {
		const manager = SessionManager.create(cwd, path.join(tmp(), "sessions"));
		if (name) manager.appendSessionInfo(name);
		const fake = fakeHost();
		const names: Array<[string, string | undefined]> = [];
		Object.assign(fake.api, {
			setSessionName: (value: string, source?: string) => {
				names.push([value, source]);
			},
		});
		registerSessions(fake.api, { commands: new Subcommands(), isSubagent: true, ...(goal ? { goal } : {}) });
		const ctx = Object.assign(fakeCtx({ cwd }), { sessionManager: manager });
		return { names, start: () => fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx) };
	};

	it("names a child's session for its goal with source goal", async () => {
		const run = child("Review the\nsessions   picker");
		await run.start();
		expect(run.names).toEqual([["Review the sessions picker", "goal"]]);
	});

	it("keeps a name a resumed child already has, and does nothing without a goal", async () => {
		const resumed = child("Review picker", "Earlier name");
		await resumed.start();
		expect(resumed.names).toEqual([]);
		const bare = child(undefined);
		await bare.start();
		expect(bare.names).toEqual([]);
	});
});
