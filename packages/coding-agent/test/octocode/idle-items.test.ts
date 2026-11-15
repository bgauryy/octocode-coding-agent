import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { renderInstruction } from "../../src/core/prompt-template.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerIdleItems } from "../../src/octocode/subagents/idle-items.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const READY = { goal: "Expected result", why: "Required work" };
const notice = (ref: string) => renderInstruction("notices/subagents/idle-item.md", { ref }).trim();

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-idle-items-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(realTeam = false) {
	const fake = fakeHost();
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const reserved = new Set<string>();
	const team = realTeam
		? new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp, "team.sqlite") })
		: { reserved: (absolute: string) => reserved.has(absolute) };
	const runs = { running: new Map<string, undefined>(), items: new Map<string, string>() };
	const lingering = new Map<string, string>();
	if (realTeam) registerCollab(fake.api, team as Team, {});
	registerIdleItems(fake.api, team as unknown as Team, runs, { onItem: (ref) => lingering.get(ref) });
	const backlog = openBacklog(ctx, { isSubagent: false });
	const hold = (title: string, paths: string[] = []) => {
		const item = backlog.store.add({ ...READY, title, state: "todo", createdBy: "user", paths });
		return backlog.store.update(item.ref, { state: "ongoing" }, backlog.actor).ref;
	};
	const settle = async () => {
		await fake.emit("agent_settled", { aborted: false }, ctx);
	};
	return { fake, cwd, runs, reserved, lingering, hold, settle, team: team as Team };
}

describe("idle item notice", () => {
	it("names an idle ongoing item once while children run, and again when the idle set changes", async () => {
		const s = setup();
		const first = s.hold("first");
		s.runs.running.set("child", undefined);
		await s.settle();
		expect(s.fake.sent).toHaveLength(1);
		expect(s.fake.sent[0]).toMatchObject({
			message: { content: notice(first) },
			options: { triggerTurn: true },
		});
		await s.settle();
		expect(s.fake.sent).toHaveLength(1);
		const second = s.hold("second");
		await s.settle();
		expect(s.fake.sent).toHaveLength(2);
		expect(s.fake.sent[1].message.content).toBe(notice(second));
	});

	it("does not name an item whose reported child can still be resumed", async () => {
		const s = setup();
		const reported = s.hold("reported");
		const free = s.hold("free");
		s.lingering.set(reported, "reported-child");
		s.runs.running.set("other", undefined);
		await s.settle();
		expect(s.fake.sent.map((entry) => entry.message.content)).toEqual([notice(free)]);
	});

	it("tells the same item again after the wait ended", async () => {
		const s = setup();
		s.hold("first");
		s.runs.running.set("child", undefined);
		await s.settle();
		s.runs.running.clear();
		await s.settle();
		s.runs.running.set("child", undefined);
		await s.settle();
		expect(s.fake.sent).toHaveLength(2);
	});

	it("says nothing for an item a running child works on", async () => {
		const s = setup();
		const ref = s.hold("linked");
		s.runs.running.set("child", undefined);
		s.runs.items.set("child", ref);
		await s.settle();
		expect(s.fake.sent).toHaveLength(0);
	});

	it("names an item whose child ended", async () => {
		const s = setup();
		const ref = s.hold("ended");
		s.runs.running.set("other", undefined);
		s.runs.items.set("gone", ref);
		await s.settle();
		expect(s.fake.sent).toHaveLength(1);
	});

	it("says nothing for an item whose paths any agent reserves, this session included", async () => {
		const s = setup();
		s.hold("reserved", ["packages/"]);
		s.reserved.add(path.resolve(s.cwd, "packages/"));
		s.runs.running.set("child", undefined);
		await s.settle();
		expect(s.fake.sent).toHaveLength(0);
	});

	it("says nothing for an item whose paths this session holds in the team database", async () => {
		const s = setup(true);
		await s.fake.emit("session_start", {}, fakeCtx({ cwd: s.cwd }));
		s.team.join("coordinate");
		s.hold("mine", ["packages/"]);
		expect(s.team.lock([path.join(s.cwd, "packages/")], "work").ok).toBe(true);
		s.runs.running.set("child", undefined);
		await s.settle();
		expect(s.fake.sent).toHaveLength(0);
		s.team.unlock();
		await s.settle();
		expect(s.fake.sent).toHaveLength(1);
	});

	it("says nothing when nothing runs", async () => {
		const s = setup();
		s.hold("idle");
		await s.settle();
		expect(s.fake.sent).toHaveLength(0);
	});

	it("says nothing after an aborted turn", async () => {
		const s = setup();
		s.hold("idle");
		s.runs.running.set("child", undefined);
		await s.fake.emit("agent_settled", { aborted: true }, fakeCtx({ cwd: s.cwd }));
		expect(s.fake.sent).toHaveLength(0);
	});
});
