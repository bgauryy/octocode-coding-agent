import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import { runForeground } from "../../src/octocode/subagents/run-execution.ts";
import { CheckIn, checkInConfig, type CheckInConfig } from "../../src/octocode/monitor/attention/check-in.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { ReportGroups } from "../../src/octocode/subagents/report-groups.ts";

const member = (id: string, parentId?: string): Member => ({
	id,
	role: id.split("-")[0],
	...(parentId ? { parentId } : {}),
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
});

const stores: TeamStore[] = [];
function team(): TeamStore {
	const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
	stores.push(store);
	for (const row of [member("p-1"), member("c-1", "p-1"), member("x-1", "p-1")]) store.save(row);
	return store;
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const ON: CheckInConfig = { seconds: 300, parentWaits: false };
const MIN = 60_000;

function checkIn(store: TeamStore) {
	const notice = vi.fn((_text: string) => true);
	return {
		notice,
		checkIn: new CheckIn({ notice, lastExchange: (me, parent) => store.refs.lastExchange(me, parent) }),
	};
}

describe("the check-in", () => {
	it("pings once the interval passes with no message, then again only after another interval", () => {
		const store = team();
		const { notice, checkIn: ping } = checkIn(store);
		const start = Date.now();
		ping.begin(start);
		ping.due("c-1", "p-1", ON, start + 4 * MIN);
		expect(notice).not.toHaveBeenCalled();
		ping.due("c-1", "p-1", ON, start + 5 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
		ping.due("c-1", "p-1", ON, start + 9 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
		ping.due("c-1", "p-1", ON, start + 10 * MIN);
		expect(notice).toHaveBeenCalledTimes(2);
	});

	it("waits for a full interval after a message in either direction, and ignores other agents' traffic", () => {
		const store = team();
		const { notice, checkIn: ping } = checkIn(store);
		const start = Date.now();
		ping.begin(start);
		store.send("x-1", ["c-1"], "from a sibling", { replyRequired: false }, start + 4 * MIN);
		ping.due("c-1", "p-1", ON, start + 5 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);

		store.send("p-1", ["c-1"], "from the parent", { replyRequired: false }, start + 7 * MIN);
		ping.due("c-1", "p-1", ON, start + 11 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
		ping.due("c-1", "p-1", ON, start + 12 * MIN);
		expect(notice).toHaveBeenCalledTimes(2);

		store.send("c-1", ["p-1"], "to the parent", { replyRequired: false }, start + 16 * MIN);
		ping.due("c-1", "p-1", ON, start + 17 * MIN);
		expect(notice).toHaveBeenCalledTimes(2);
		ping.due("c-1", "p-1", ON, start + 21 * MIN);
		expect(notice).toHaveBeenCalledTimes(3);
	});

	it("does nothing for an agent with no parent, or when the setting is 0", () => {
		const store = team();
		const { notice, checkIn: ping } = checkIn(store);
		const start = Date.now();
		ping.begin(start);
		ping.due("p-1", undefined, ON, start + 60 * MIN);
		ping.due("c-1", "p-1", { ...ON, seconds: 0 }, start + 60 * MIN);
		expect(notice).not.toHaveBeenCalled();
	});

	it("does not read the database before the interval has passed", () => {
		const store = team();
		const read = vi.spyOn(store.refs, "lastExchange");
		const { checkIn: ping } = checkIn(store);
		const start = Date.now();
		ping.begin(start);
		ping.due("c-1", "p-1", ON, start + 4 * MIN);
		expect(read).not.toHaveBeenCalled();
	});

	it("tries again at the next step when the session could not take the ping", () => {
		const store = team();
		const notice = vi.fn((_text: string) => false);
		const ping = new CheckIn({ notice, lastExchange: (me, parent) => store.refs.lastExchange(me, parent) });
		const start = Date.now();
		ping.begin(start);
		ping.due("c-1", "p-1", ON, start + 5 * MIN);
		notice.mockReturnValue(true);
		ping.due("c-1", "p-1", ON, start + 5 * MIN + 1);
		expect(notice).toHaveBeenCalledTimes(2);
	});

	it("selects the appropriate check-in message for foreground and background delivery", () => {
		const store = team();
		const { notice, checkIn: ping } = checkIn(store);
		const start = Date.now();
		ping.begin(start);
		ping.due("c-1", "p-1", ON, start + 5 * MIN);
		const background = notice.mock.calls[0][0];
		expect(background).toBe(renderPrompt("notices/monitor/check-in.md", { interval: "5m", parentWaits: false }));
		ping.due("c-1", "p-1", { ...ON, parentWaits: true }, start + 10 * MIN);
		const foreground = notice.mock.calls[1][0];
		expect(foreground).toBe(renderPrompt("notices/monitor/check-in.md", { interval: "5m", parentWaits: true }));
	});
});

describe("checkInConfig", () => {
	it("reads the setting, 0 included, and takes the default for a value the schema refuses", () => {
		expect(SETTINGS_DEFAULTS.subagents.checkInSeconds).toBe(300);
		expect(checkInConfig({ subagents: { checkInSeconds: 42 } }, false).seconds).toBe(42);
		expect(checkInConfig({ subagents: { checkInSeconds: 0 } }, false).seconds).toBe(0);
		expect(checkInConfig(undefined, false).seconds).toBe(300);
		expect(checkInConfig({ subagents: { checkInSeconds: -1 } }, false).seconds).toBe(300);
	});

	it("reads whether the parent waits from what the parent set", () => {
		expect(checkInConfig(undefined, false).parentWaits).toBe(false);
		expect(checkInConfig(undefined, true).parentWaits).toBe(true);
	});
});

describe("a foreground child's report", () => {
	// The run audit a parent keeps: a run is begun and finished around each foreground child.
	const audit = { begin: vi.fn(), finish: vi.fn(), hint: vi.fn() };
	const run = () => ({
		identity: { id: "c-1" },
		route: { model: undefined },
	});
	const details = () => ({ id: "c-1", profile: "", goal: "", toolCalls: 0, activity: [], startedAt: Date.now() });
	const launch = (outcome: Record<string, unknown>) => () =>
		Promise.resolve({ text: "done: yes", usage: {}, ...outcome });

	it("closes the questions its parent put to it, as a background child's does", async () => {
		const closeQuestionsTo = vi.fn();
		const runs = {
			foreground: new Map(),
			groups: new ReportGroups(),
			reports: { reportingChanged: () => undefined },
			team: { closeQuestionsTo, audit, approvals: { noteExited: () => undefined } },
		};
		await runForeground(
			runs as never,
			run() as never,
			details() as never,
			launch({ outcome: "done" }) as never,
			() => Promise.resolve(""),
			"",
			undefined,
			() => undefined,
		);
		expect(closeQuestionsTo).toHaveBeenCalledWith("c-1");
	});

	it("still returns the report when closing them fails", async () => {
		const closeQuestionsTo = vi.fn(() => {
			throw new Error("database is locked");
		});
		const runs = {
			foreground: new Map(),
			groups: new ReportGroups(),
			reports: { reportingChanged: () => undefined },
			team: { closeQuestionsTo, audit, approvals: { noteExited: () => undefined } },
		};
		const result = await runForeground(
			runs as never,
			run() as never,
			details() as never,
			launch({ outcome: "done" }) as never,
			() => Promise.resolve(""),
			"",
			undefined,
			() => undefined,
		);
		expect(closeQuestionsTo).toHaveBeenCalled();
		expect(JSON.stringify(result.content)).toContain("done: yes");
	});

	it("leaves them open when the run failed, so the parent hears they went unanswered", async () => {
		const closeQuestionsTo = vi.fn();
		const runs = {
			foreground: new Map(),
			groups: new ReportGroups(),
			reports: { reportingChanged: () => undefined },
			team: { closeQuestionsTo, audit, approvals: { noteExited: () => undefined } },
		};
		await runForeground(
			runs as never,
			run() as never,
			details() as never,
			launch({ error: "the provider failed" }) as never,
			() => Promise.resolve(""),
			"",
			undefined,
			() => undefined,
		);
		expect(closeQuestionsTo).not.toHaveBeenCalled();
	});
});
