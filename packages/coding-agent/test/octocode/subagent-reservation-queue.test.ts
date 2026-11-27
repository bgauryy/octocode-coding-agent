import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

/** A start whose paths only running children of this session hold waits for their release. */

const FIXTURE = path.join(import.meta.dirname, "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-queue-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "peer",
	pid: process.pid,
	status: "working",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

const open: TeamStore[] = [];
const teams: Team[] = [];
const controls: Array<{ stopAll(): Promise<void> }> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const control of controls.splice(0)) await control.stopAll();
	for (const team of teams.splice(0)) team.stop();
	for (const store of open.splice(0)) {
		for (const id of store.names()) store.remove(id);
		store.close();
	}
});

function setup() {
	const cwd = fs.realpathSync(tmp("octocode-queue-cwd-"));
	const f = fakeHost();
	const team = new Team(f.api);
	teams.push(team);
	const control = registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission() });
	controls.push(control);
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx.ui, { confirm: async () => true });
	const model = { provider: "faux", id: "model", reasoning: true };
	Object.assign(ctx, {
		model,
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [model],
			find: () => model,
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	team.join();
	const agent = f.tools.get("agent");
	const run = (
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (update: { content: Array<{ text?: string }> }) => void,
	) => agent.execute("call-1", { goal: "check things", ...params }, signal, onUpdate, ctx);
	const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
	open.push(store);
	/** The reservations in this checkout, by owner, as another process reads them. */
	const leases = () => store.leases().map((lease) => `${lease.owner}:${lease.path}`);
	/** A sibling that holds `paths` until it is stopped. */
	const holder = async (paths: string[]) => {
		const started = await run({ task: "slow background", background: true, paths });
		return started.details.id as string;
	};
	return { ...f, team, control, ctx, run, cwd, store, leases, holder };
}

const textOf = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";

describe("a background start behind a sibling's paths", () => {
	it("returns at once naming who it waits for, holds nothing, and starts after the release", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const queued = await s.run({ task: "slow background", goal: "second", background: true, paths: ["a.ts", "b.ts"] });
		const second = queued.details.id as string;
		expect(textOf(queued)).toMatch(
			new RegExp(`Queued ${second}[^]*waiting for ${first} to report before it reserves a\\.ts, b\\.ts`),
		);
		expect(queued.details).toMatchObject({ status: "background", queued: true });
		expect(s.control.running().sort()).toEqual([first, second].sort());
		// Nothing of b.ts is taken while it waits: all or none, and it holds no lease.
		expect(s.leases()).toEqual([`${first}:a.ts`]);

		expect(s.control.stop(first, "the parent")).toBeUndefined();
		await vi.waitFor(() => expect(s.leases().sort()).toEqual([`${second}:a.ts`, `${second}:b.ts`]));
		expect(s.control.running()).toEqual([second]);
		expect(queued.details.queued).toBeUndefined();
		expect(s.control.stop(second, "the parent")).toBeUndefined();
		await s.control.settle();
		expect(s.leases()).toEqual([]);
	});

	it("queues a third behind the second that took the paths first, one after the other", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const second = (await s.run({ task: "slow background", background: true, paths: ["a.ts"] })).details.id as string;
		const third = (await s.run({ task: "slow background", background: true, paths: ["a.ts"] })).details.id as string;
		s.control.stop(first, "the parent");
		// Both woke; the one that reserved first holds it, the other waits again for it rather than failing.
		await vi.waitFor(() => expect(s.leases()).toHaveLength(1));
		await vi.waitFor(() => expect(s.leases()[0]).not.toContain(first));
		const holding = s.leases()[0].split(":")[0];
		expect([second, third]).toContain(holding);
		const waiting = holding === second ? third : second;
		expect(s.control.running().sort()).toEqual([holding, waiting].sort());
		s.control.stop(holding, "the parent");
		await vi.waitFor(() => expect(s.leases()).toEqual([`${waiting}:a.ts`]));
	});

	it("refuses at that point, as a background report, when another agent took a path meanwhile", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const released = s.team.childLeases.released.bind(s.team.childLeases);
		vi.spyOn(s.team.childLeases, "released").mockImplementation(async (...args) => {
			await released(...args);
			s.store.save(member("peer-one", { goal: "fix auth" }));
			s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "token refresh" }]);
		});
		const queued = await s.run({ task: "report back", background: true, paths: ["a.ts"] });
		const id = queued.details.id as string;
		s.control.stop(first, "the parent");
		await s.control.settle();
		expect(s.control.running()).toEqual([]);
		expect(s.leases()).toEqual(["peer-one:a.ts"]);
		const reports = JSON.stringify(s.sent.map((entry) => entry.message));
		expect(reports).toContain(`Background subagent ${id}`);
		expect(reports).toMatch(/No subagent started: paths it would edit are reserved[^]*a\.ts is covered by peer-one/);
	});
});

describe("cancelling a start that waits", () => {
	it("stops a queued background start: it never reserves or runs, and the holder is untouched", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const second = (await s.run({ task: "report back", background: true, paths: ["a.ts"] })).details.id as string;
		expect(s.control.stop(second, "the parent")).toBeUndefined();
		await vi.waitFor(() => expect(s.control.running()).toEqual([first]));
		expect(s.leases()).toEqual([`${first}:a.ts`]);
		// The release that follows starts nothing.
		s.control.stop(first, "the parent");
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		expect(s.control.running()).toEqual([]);
	});

	it("ends a foreground start that its turn aborts, holding and running nothing", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const abort = new AbortController();
		const waiting = s.run({ task: "report back", paths: ["a.ts"] }, abort.signal);
		const settled = expect(waiting).rejects.toThrow();
		abort.abort();
		await settled;
		expect(s.control.running()).toEqual([first]);
		expect(s.leases()).toEqual([`${first}:a.ts`]);
		// No waiter is left behind to start at the release.
		s.control.stop(first, "the parent");
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		expect(s.control.running()).toEqual([]);
	});
});

describe("a holder that is not a running child of this session", () => {
	it("refuses with the old text for another agent, even when a sibling also holds a path", async () => {
		const s = setup();
		const first = await s.holder(["b.ts"]);
		s.store.save(member("peer-one", { goal: "fix the auth flow" }));
		s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "token refresh" }]);
		for (const background of [true, false]) {
			await expect(s.run({ task: "report back", background, paths: ["a.ts", "b.ts"] })).rejects.toThrow(
				/No subagent started: paths it would edit are reserved; nothing was locked\.[^]*a\.ts is covered by peer-one, working on "fix the auth flow"[^]*Wait for the holder's report \(unlock if the holder is you\)/,
			);
		}
		expect(s.control.running()).toEqual([first]);
		expect(s.leases().sort()).toEqual([`${first}:b.ts`, "peer-one:a.ts"].sort());
	});

	it("refuses a path the parent itself locked", async () => {
		const s = setup();
		s.team.lock(["a.ts"], "mine");
		await expect(s.run({ task: "report back", background: true, paths: ["a.ts"] })).rejects.toThrow(
			/unlock if the holder is you/,
		);
		expect(s.control.running()).toEqual([]);
	});
});

describe("a foreground start behind a sibling's paths", () => {
	it("waits with a progress line, then runs and reports once the sibling is released", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const lines: string[] = [];
		let done = false;
		const result = s
			.run({ task: "report back", paths: ["a.ts"] }, undefined, (update) => lines.push(update.content[0]?.text ?? ""))
			.then((value: unknown) => {
				done = true;
				return value as { details: { status: string }; content: Array<{ text?: string }> };
			});
		await vi.waitFor(() => expect(lines).toEqual([`waiting for ${first} to report before it reserves a.ts`]));
		expect(done).toBe(false);
		// Unclaimed while it waits: no name, no lease, no slot.
		expect(s.control.running()).toEqual([first]);
		expect(s.leases()).toEqual([`${first}:a.ts`]);

		s.control.stop(first, "the parent");
		const finished = await result;
		expect(finished.details.status).toBe("done");
		expect(finished.content[0]?.text).toContain("Reserved until it reports: a.ts.");
		await s.control.settle();
		expect(s.leases()).toEqual([]);
	});

	it("lets two foreground starts woken by one release run one after the other, neither refused", async () => {
		const s = setup();
		const first = await s.holder(["a.ts"]);
		const both = [s.run({ task: "report back", paths: ["a.ts"] }), s.run({ task: "report back", paths: ["a.ts"] })];
		await vi.waitFor(() => expect(s.control.running()).toEqual([first]));
		s.control.stop(first, "the parent");
		const results = (await Promise.all(both)) as Array<{ details: { status: string } }>;
		expect(results.map((result) => result.details.status)).toEqual(["done", "done"]);
		await s.control.settle();
		expect(s.leases()).toEqual([]);
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
