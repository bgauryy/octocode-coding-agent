import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timers } from "../../../../db/src/api.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { workspaceDb } from "../../../src/storage/workspace-database.ts";
import { tmp } from "../helpers.ts";
import { backlogRig, completion, restoreBacklogEnv } from "./backlog-rig.ts";
import { count, createRig, quiet, sleep, type Rig } from "./rig.ts";

/**
 * `notify` with an `until` condition through a real session (RFC agent-event-loop R0, §4): `on` stores one condition of
 * the closed list; the scheduler checks it (a command polls every 15 s, a backlog condition follows the database) and the
 * first check that holds wakes the session as a steer, once. A refused condition is the tool's error, nothing is stored.
 * R3/R5 move conditions onto the `timer.due` / `check.result` topics; what wakes and when must not change.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
	restoreBacklogEnv();
});

async function timed() {
	const db = path.join(tmp(), "octocode.db");
	process.env.OCTOCODE_AGENT_DB = db;
	const rig = await createRig({
		register: (api) =>
			registerTimers(api, {
				reservation: () => undefined,
				agent: () => undefined,
				env: { ...process.env, OCTOCODE_AGENT_DB: db },
			}),
	});
	rigs.push(rig);
	return rig;
}

const on = (args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall("notify", { op: "on", reason: "characterize", ...args }), {
		stopReason: "toolUse",
	});

/** The text of the `notify` tool results of the session. */
const toolTexts = (rig: Rig) =>
	rig.harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify(message.content));

/** The session's timer rows, ended ones too: what the scheduler has left to check, and what its last check found. */
const timerRows = (rig: Rig) =>
	timers.forSession(workspaceDb(rig.ctx.cwd).agent.db, rig.ctx.sessionManager.getSessionId(), true);

const armed = async (rig: Rig, call: Record<string, unknown>, answer = "armed") => {
	rig.harness.setResponses([on(call), fauxAssistantMessage(answer), rig.reply("woken by the condition")]);
	await rig.harness.session.prompt("wait for it");
	await rig.harness.session.waitForIdle();
};

describe("an until condition that holds", () => {
	it("a command that exits 0 wakes the idle session once, with its note and the command's output", async () => {
		const r = await timed();
		await armed(r, { event: "check.result", filter: { command: "echo UNTIL-OUT" }, note: "UNTIL-NOTE" });
		expect(r.requests).toHaveLength(0);
		await vi.waitFor(() => expect(r.requests).toHaveLength(1), { timeout: 20_000 });
		await r.harness.session.waitForIdle();
		expect(count(r.requests[0], "Note: UNTIL-NOTE")).toBe(1);
		expect(count(r.requests[0], "UNTIL-OUT")).toBeGreaterThan(0);
		// Once: the timer ended with its wake, so the scheduler has nothing left to check and nothing else comes.
		expect(timerRows(r)).toMatchObject([{ status: "done", last_exit: 0 }]);
		await quiet(r);
		expect(r.requests).toHaveLength(1);
	});

	it("a command that does not exit 0 wakes nobody; the check that finally holds does, within one poll", async () => {
		const r = await timed();
		const flag = path.join(tmp(), "flag");
		await armed(r, { event: "check.result", filter: { command: `test -e ${flag}` }, note: "FLAG-NOTE" });
		// The scheduler ran the command and recorded its failure: the wait goes on and nobody was woken.
		await vi.waitFor(() => expect(timerRows(r)).toMatchObject([{ status: "active", last_exit: 1 }]), {
			timeout: 30_000,
			interval: 50,
		});
		await quiet(r);
		expect(r.requests).toHaveLength(0);
		fs.writeFileSync(flag, "x");
		await vi.waitFor(() => expect(r.requests).toHaveLength(1), { timeout: 30_000 });
		await r.harness.session.waitForIdle();
		expect(count(r.requests[0], "Note: FLAG-NOTE")).toBe(1);
		expect(timerRows(r)).toMatchObject([{ status: "done", last_exit: 0 }]);
	}, 75_000);
});

describe("an until condition the tool refuses", () => {
	it.each([
		// The schema lists only the events `on` can listen for; the rest fail validation before the tool runs.
		["an event that already wakes the session", { event: "job.exit" }, /Validation failed[\s\S]*expected one of/],
		["a time", { event: "time.due" }, /Validation failed[\s\S]*expected one of/],
		["an event outside the catalog", { event: "nonsense.event" }, /Validation failed[\s\S]*expected one of/],
		["a filter the event does not take", { event: "path.unlocked", filter: { ref: "B1" } }, /filters on path/],
		[
			"an item that does not exist",
			{ event: "item.state", filter: { ref: "B99", state: "done" } },
			/No backlog item B99/,
		],
	])("%s: the call errors and no wake follows", async (_name, call, message) => {
		const r = await timed();
		await armed(r, call);
		expect(toolTexts(r).join("\n")).toMatch(message);
		// Nothing was stored, so no check can ever run for it.
		expect(timerRows(r)).toEqual([]);
		await quiet(r);
		expect(r.requests).toHaveLength(0);
	});
});

/** Longer than the scheduler's debounce between a change and the check it asks for (150 ms). */
const CHECK_AFTER_CHANGE_MS = 500;

describe("a backlog until condition", () => {
	it("item.state wakes once when another actor moves the item to that state, and not before", async () => {
		// The backlog feed announces each audited change, so the wait wakes at once, not at its next poll.
		const {
			rig: r,
			store,
			fed,
		} = await backlogRig({
			also: (api) => registerTimers(api, { reservation: () => undefined, agent: () => undefined, env: process.env }),
		});
		rigs.push(r);
		store.add({ title: "Awaited", goal: "checkable", why: "needed", createdBy: "user", state: "todo" });
		await armed(r, { event: "item.state", filter: { ref: "B1", state: "done" }, note: "ITEM-NOTE" });
		expect(toolTexts(r).join("\n")).not.toMatch(/No backlog item/);
		// The feed announces each change to the wait; its check follows a fixed debounce and, finding nothing, writes
		// nothing, so the pause after the announcement is the only way to see that check through from outside.
		store.update("B1", { note: "progress" }, { id: "peer" });
		await fed({ ref: "B1", kind: "note", by: "peer" });
		await sleep(CHECK_AFTER_CHANGE_MS);
		await quiet(r);
		expect(r.requests).toHaveLength(0);
		store.update("B1", { state: "ongoing" }, { id: "peer" });
		await fed({ ref: "B1", kind: "claimed", by: "peer" });
		await sleep(CHECK_AFTER_CHANGE_MS);
		await quiet(r);
		expect(r.requests).toHaveLength(0);
		expect(timerRows(r)).toMatchObject([{ status: "active" }]);
		store.update("B1", { state: "done", completion: completion("until-1") }, { id: "peer" });
		await vi.waitFor(() => expect(r.requests).toHaveLength(1), { timeout: 20_000 });
		await r.harness.session.waitForIdle();
		expect(count(r.requests[0], "Note: ITEM-NOTE")).toBe(1);
		expect(timerRows(r)).toMatchObject([{ status: "done" }]);
	}, 40_000);
});
