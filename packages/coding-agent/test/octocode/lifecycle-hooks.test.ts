import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_CATALOG, profileEvents, profileSupport } from "../../src/octocode/hooks/catalog.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
import { agentHookInput } from "../../src/octocode/hooks/register/agents.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../../src/octocode/shared/agent-lifecycle.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx as plainCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const log = `cat >> LOG.jsonl; printf '\\n' >> LOG.jsonl`;
const hook = (file: string, matcher = "", extra: Record<string, unknown> = {}) => [
	{ matcher, hooks: [{ type: "command", command: log.replace("LOG", file), ...extra }] },
];
const recorded = (cwd: string, file: string): Array<Record<string, any>> =>
	fs.existsSync(path.join(cwd, `${file}.jsonl`))
		? fs
				.readFileSync(path.join(cwd, `${file}.jsonl`), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];

function project(hooks: unknown): string {
	const cwd = tmp("octocode-agent-hooks-");
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".octocode"));
	fs.writeFileSync(path.join(cwd, ".octocode", "hooks.json"), JSON.stringify({ hooks }));
	return cwd;
}

/** A host whose `api.events` really delivers, so the team's announcements reach the hooks. */
function host() {
	const fake = fakeHost();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	(fake.api as { events: unknown }).events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => undefined;
		},
		emit: (channel: string, data: unknown) => {
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
	};
	return fake;
}

/** A session with a file: only a persisted session writes the presence events the hooks follow. */
const fakeCtx = (options: Parameters<typeof plainCtx>[0]) => {
	const ctx = plainCtx(options);
	(ctx.sessionManager as { getSessionFile(): string }).getSessionFile = () => path.join(options.cwd, "session.jsonl");
	return ctx;
};

const teams: Team[] = [];
const stores: TeamStore[] = [];
beforeEach(() => vi.stubEnv("OCTOCODE_HOME", tmp("octocode-agent-hooks-home-")));
afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});

async function setup(hooks: unknown) {
	const cwd = project(hooks);
	const fake = host();
	const ctx = fakeCtx({ cwd, hasUI: false });
	const dbFile = path.join(tmp(), "team.sqlite");
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	teams.push(team);
	approveFixtureHooks(cwd);
	const view = registerHooks(fake.api, { env: {}, home: tmp() });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	team.start(ctx);
	// Another Octocode process: its own connection to the same database.
	const peer = TeamStore.open(cwd, dbFile, {});
	peer.lifecycle = { activationId: "peer", sessionId: "peer-session" };
	stores.push(peer);
	return { ...fake, cwd, ctx, team, peer, view };
}
const child = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "researcher",
	pid: process.pid,
	status: "working",
	joinedAt: Date.now() - 5000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

describe("AgentOn and AgentOff in the catalog", () => {
	it("are Octocode-profile observers and no other host's events", () => {
		for (const event of ["AgentOn", "AgentOff"] as const) {
			expect(Object.keys(HOOK_CATALOG[event].profiles)).toEqual(["octocode"]);
			expect(profileSupport("octocode", event)).toMatchObject({ timeout: 1.5, maxTimeout: 60 });
			expect(profileEvents("claude")).not.toContain(event);
			expect(profileEvents("codex")).not.toContain(event);
		}
		// Claude and Codex keep their own subagent events, unchanged.
		expect(Object.keys(HOOK_CATALOG.SubagentStart.profiles)).toEqual(["claude", "codex"]);
		expect(Object.keys(HOOK_CATALOG.SubagentStop.profiles)).toEqual(["claude", "codex"]);
	});

	it("load from an Octocode hooks file, and a Claude settings file's use of them is reported", () => {
		const home = tmp("octocode-agent-hooks-home-");
		const cwd = project({ AgentOn: hook("on"), AgentOff: hook("off", "failed|crashed") });
		fs.mkdirSync(path.join(cwd, ".claude"));
		fs.writeFileSync(
			path.join(cwd, ".claude", "settings.json"),
			JSON.stringify({ hooks: { AgentOff: hook("claude-off") } }),
		);
		const loaded = loadHooks(cwd, true, home);
		expect(loaded.config.AgentOn.flatMap((group) => group.hooks.map((each) => each.protocol ?? "octocode"))).toEqual([
			"octocode",
		]);
		expect(loaded.config.AgentOff.flatMap((group) => group.hooks.map((each) => each.protocol ?? "octocode"))).toEqual([
			"octocode",
		]);
		expect(loaded.errors.join("\n")).toContain("AgentOff");
	});
});

describe("the AgentOn and AgentOff input", () => {
	const notice = (extra: Partial<AgentLifecycleNotice> = {}): AgentLifecycleNotice => ({
		seq: 12,
		kind: "on",
		agent: "amber-otter",
		role: "researcher",
		parent: "main-fox",
		time: "2026-11-04T10:00:05.000Z",
		data: { model: "anthropic/sonnet", goal: "Read the logs" },
		...extra,
	});

	it("names the agent, its parent and what it was asked", () => {
		expect(agentHookInput(notice())).toEqual({
			seq: 12,
			agent_id: "amber-otter",
			agent_type: "researcher",
			kind: "child",
			parent_agent_id: "main-fox",
			// What a run records (`lifecycle-links.test.ts`) is null until it is recorded.
			parent_session_id: null,
			branch: null,
			backlog_item: null,
			run_id: null,
			model: "anthropic/sonnet",
			goal: "Read the logs",
			pid: process.pid,
		});
		expect(agentHookInput(notice({ parent: null, role: undefined, data: {} }))).toMatchObject({
			kind: "main",
			agent_type: "general",
			model: null,
			goal: null,
		});
	});

	it("adds the end reason and final numbers for an end", () => {
		const joined = Date.parse("2026-11-04T10:00:00.000Z");
		const input = agentHookInput(
			notice({
				kind: "off",
				reason: "failed",
				detail: "provider error",
				stats: {
					joinedAt: joined,
					pid: 4242,
					status: "working",
					toolCalls: 7,
					input: 100,
					cacheRead: 40,
					output: 20,
					cost: 0.25,
				},
			}),
		);
		expect(input).toMatchObject({
			reason: "failed",
			detail: "provider error",
			pid: 4242,
			started_at: "2026-11-04T10:00:00.000Z",
			ended_at: "2026-11-04T10:00:05.000Z",
			duration_ms: 5000,
			status: "working",
			tool_calls: 7,
			tokens: { input: 100, cache_read: 40, output: 20 },
			cost: 0.25,
		});
	});

	it("leaves a missing number null instead of inventing one", () => {
		expect(agentHookInput(notice({ kind: "off", reason: "crashed", stats: {} }))).toMatchObject({
			started_at: null,
			duration_ms: null,
			tool_calls: null,
			tokens: { input: null, cache_read: null, output: null },
			cost: null,
		});
	});
});

describe("the hooks, driven by the team", () => {
	it("runs AgentOn when this agent joins and AgentOff, with the reason and stats, when it leaves", async () => {
		const { team, cwd, fire } = await setup({ AgentOn: hook("on"), AgentOff: hook("off") });
		const me = team.join("Check the build");
		await vi.waitFor(() => expect(recorded(cwd, "on")).toHaveLength(1));
		team.leave("completed");
		// The session's end waits for the hooks the leave started.
		await fire("session_shutdown", { reason: "quit" }, fakeCtx({ cwd, hasUI: false }));
		expect(recorded(cwd, "on")).toEqual([
			expect.objectContaining({
				hook_event_name: "AgentOn",
				agent_id: me.id,
				kind: "main",
				parent_agent_id: null,
				// A main session joins when it starts, before any goal is named.
				goal: null,
				pid: process.pid,
			}),
		]);
		expect(recorded(cwd, "off")).toEqual([
			expect.objectContaining({
				hook_event_name: "AgentOff",
				agent_id: me.id,
				reason: "completed",
				tool_calls: expect.any(Number),
				tokens: { input: expect.any(Number), cache_read: expect.any(Number), output: expect.any(Number) },
			}),
		]);
		expect(recorded(cwd, "off")[0].seq).toBeGreaterThan(recorded(cwd, "on")[0].seq);
	});

	it("matches AgentOn by role and AgentOff by end reason", async () => {
		const { team, cwd, fire } = await setup({
			AgentOn: [...hook("main-on", "main"), ...hook("other-on", "researcher")],
			AgentOff: [...hook("bad-off", "failed|crashed"), ...hook("good-off", "completed")],
		});
		team.join();
		await vi.waitFor(() => expect(recorded(cwd, "main-on")).toHaveLength(1));
		team.leave("failed");
		await fire("session_shutdown", { reason: "quit" }, fakeCtx({ cwd, hasUI: false }));
		expect(recorded(cwd, "other-on")).toEqual([]);
		expect(recorded(cwd, "bad-off")).toEqual([expect.objectContaining({ reason: "failed" })]);
		expect(recorded(cwd, "good-off")).toEqual([]);
	});

	it("runs AgentOff for a dead child this process reaps, but not for what another process wrote", async () => {
		const { team, peer, cwd, fire } = await setup({ AgentOn: hook("on"), AgentOff: hook("off") });
		team.join();
		await vi.waitFor(() => expect(recorded(cwd, "on")).toHaveLength(1));
		// Another process: its child joins and leaves cleanly. Not this process's transition to report.
		const theirs = child("theirs-lynx");
		peer.join(theirs);
		peer.remove(theirs.id, Date.now(), theirs, "completed");
		// A child of this process died without leaving: this process's sweep retires it.
		peer.join(child("dead-heron", { pid: 2 ** 22 + 777, parentId: team.id }));
		(team as unknown as { database: { store(): TeamStore } }).database.store().sweep(Date.now());
		await fire("session_shutdown", { reason: "quit" }, fakeCtx({ cwd, hasUI: false }));
		expect(recorded(cwd, "on").map((entry) => entry.agent_id)).toEqual([team.id]);
		expect(recorded(cwd, "off")).toEqual([
			expect.objectContaining({ agent_id: "dead-heron", reason: "crashed", kind: "child", parent_agent_id: team.id }),
		]);
	});

	it("cannot be made to block: a failing failClosed hook neither stops the leave nor fails the shutdown", async () => {
		const { team, cwd, fire, view } = await setup({
			AgentOn: hook("on", "", { failClosed: true }),
			AgentOff: [{ matcher: "", hooks: [{ type: "command", command: "echo no >&2; exit 2", failClosed: true }] }],
		});
		const me = team.join();
		expect(() => team.leave("completed")).not.toThrow();
		await expect(fire("session_shutdown", { reason: "quit" }, fakeCtx({ cwd, hasUI: false }))).resolves.not.toThrow();
		expect(team.id).toBeUndefined();
		const store = TeamStore.open(cwd, path.join(path.dirname(cwd), "unused"), {});
		store.close();
		expect(view.summary()).toContain("hook");
		expect(me.id).toBeTruthy();
	});

	it("does nothing in a session whose hooks are off", async () => {
		const cwd = project({ AgentOn: hook("on"), AgentOff: hook("off") });
		const fake = host();
		const ctx = fakeCtx({ cwd, hasUI: false });
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		teams.push(team);
		registerHooks(fake.api, { env: { OCTOCODE_SUBAGENT: "1" }, home: tmp() });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		team.start(ctx);
		team.join();
		team.leave("completed");
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
		expect(recorded(cwd, "on")).toEqual([]);
		expect(recorded(cwd, "off")).toEqual([]);
	});

	it("announces on the channel only what this process wrote", async () => {
		const cwd = project({});
		const fake = host();
		const heard: AgentLifecycleNotice[] = [];
		fake.api.events.on(AGENT_LIFECYCLE_CHANNEL, (data) => heard.push(data as AgentLifecycleNotice));
		const dbFile = path.join(tmp(), "team.sqlite");
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
		teams.push(team);
		team.start(fakeCtx({ cwd, hasUI: false }));
		const me = team.join();
		const peer = TeamStore.open(cwd, dbFile, {});
		peer.lifecycle = { activationId: "peer", sessionId: "peer-session" };
		stores.push(peer);
		peer.join(child("theirs-lynx"));
		team.leave();
		expect(heard.map((notice) => [notice.kind, notice.agent])).toEqual([
			["on", me.id],
			["off", me.id],
		]);
		expect(HOOK_CATALOG.AgentOn.profiles.octocode.timeout).toBe(1.5);
	});
});
