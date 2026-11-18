import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { Team } from "../../src/octocode/team/session.ts";
import {
	AGENT_ID_ENV,
	PARENT_HOLDS_LEASES_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
} from "../../src/octocode/team/store/env.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const row = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
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
const A = [{ path: "a.ts", kind: "file" as const, reason: "" }];
const DEAD_PID = 2 ** 22 + 4242;

const stores: TeamStore[] = [];
const teams: Team[] = [];
afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});

function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const store = TeamStore.open(cwd, file, {});
	stores.push(store);
	const start = (env: Record<string, string>) => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: file, ...env });
		registerCollab(fake.api, team);
		team.start(fakeCtx({ cwd, hasUI: true, idle: true }));
		teams.push(team);
		return team;
	};
	return { cwd, store, start };
}

describe("a headless child whose parent holds its reservations", () => {
	function run(holds: boolean) {
		const s = setup();
		const parent = s.start({});
		const me = parent.join();
		expect(parent.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"])).toMatchObject({
			ok: true,
		});
		const started = processStartTime(process.pid);
		const child = s.start({
			[AGENT_ID_ENV]: "kid-one",
			[PARENT_ID_ENV]: me.id,
			OCTOCODE_SUBAGENT: "1",
			[PARENT_PID_ENV]: [process.pid, started].filter(Boolean).join(" "),
			...(holds ? { [PARENT_HOLDS_LEASES_ENV]: "1" } : {}),
		});
		return { ...s, parent, child, me };
	}

	it("keeps its leases at settle until the parent releases the run, then frees them", () => {
		const { store, parent, child } = run(true);
		expect(store.lock("peer", A).ok).toBe(false);
		child.onAgentSettled("completed");
		expect(store.names()).toContain("kid-one");
		expect(store.list().map((member) => member.id)).not.toContain("kid-one");
		expect(store.reachable().has("kid-one")).toBe(false);
		expect(store.lock("peer", A)).toMatchObject({ ok: false, conflicts: [{ heldBy: { owner: "kid-one" } }] });
		parent.childLeases.release("kid-one");
		expect(store.names()).not.toContain("kid-one");
		expect(store.lock("peer", A).ok).toBe(true);
	});

	it("dead-letters mail sent to it after it settled", () => {
		const { store, me, child } = run(true);
		child.onAgentSettled("completed");
		expect(store.send(me.id, ["kid-one"], "one more thing", { replyRequired: false })).toMatchObject({
			id: undefined,
			departed: ["kid-one"],
		});
	});

	it("dead-letters mail it had not read when it settled", () => {
		const { store, me, child } = run(true);
		const sent = store.send(me.id, ["kid-one"], "unread", { replyRequired: false });
		expect(sent.id).toBeDefined();
		child.onAgentSettled("completed");
		expect(store.deadLetters(me.id).flatMap((letter) => letter.recipients)).toContain("kid-one");
	});

	it("still leaves at once when the parent reserved nothing for it", () => {
		const { store, child } = run(false);
		child.onAgentSettled("completed");
		expect(store.names()).not.toContain("kid-one");
		expect(store.lock("peer", A).ok).toBe(true);
	});
});

describe("TeamStore.settle", () => {
	it("keeps the leases of a child whose own process is gone, which a plain row loses at the first conflict check", () => {
		const { store } = setup();
		const parent = {
			pid: process.pid,
			...(processStartTime(process.pid) ? { started: processStartTime(process.pid)! } : {}),
		};
		for (const id of ["kid-plain", "kid-settled"]) {
			expect(store.join(row(id, { pid: DEAD_PID }))).toBe(true);
			expect(store.lock(id, [{ path: `${id}.ts`, kind: "file", reason: "" }]).ok).toBe(true);
		}
		expect(store.settle("kid-settled", { pid: DEAD_PID }, parent, "completed")).toBe(true);
		expect(store.lock("peer", [{ path: "kid-plain.ts", kind: "file", reason: "" }]).ok).toBe(true);
		expect(store.lock("peer", [{ path: "kid-settled.ts", kind: "file", reason: "" }]).ok).toBe(false);
		expect(store.settle("kid-settled", { pid: DEAD_PID }, parent)).toBe(false);
		// The old process cannot bring it back.
		expect(store.save(row("kid-settled", { pid: DEAD_PID }))).toBe(false);
		expect(store.list().map((member) => member.id)).not.toContain("kid-settled");
	});
});
