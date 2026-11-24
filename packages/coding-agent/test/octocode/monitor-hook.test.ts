import { describe, expect, it, vi } from "vitest";
import { eventSubscriptions, events } from "../../../db/src/api.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { emptyHooks } from "../../src/octocode/hooks/config/parse.ts";
import { HOOK_CATALOG, HOOK_EVENTS, type HookEvent } from "../../src/octocode/hooks/catalog.ts";
import { registerMonitorHooks, type MonitorHookOptions } from "../../src/octocode/hooks/register/monitor.ts";
import type { HookSession } from "../../src/octocode/hooks/register/types.ts";
import { ATTENTION_RULES } from "../../src/octocode/monitor/attention/rules.ts";
import { monitorLedgerOf } from "../../src/octocode/monitor/ledger.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { tmp } from "./helpers.ts";

/**
 * A session with one MonitorAlert group, a real ledger and a dispatch that runs a hook only when the configured matcher
 * selects the rule (`commandsFor`, the dispatcher's own selection), so what it records is what a user's hook would see.
 */
function harness(matcher: string | undefined | null, options: MonitorHookOptions = {}, cwd = tmp()) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = {
		bus: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		},
	};
	const session: HookSession = { config: emptyHooks(), errors: [], root: undefined };
	if (matcher !== null)
		session.config.MonitorAlert = [
			{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command: "true", timeoutMs: 100 }] },
		] as never;
	const runs: Run[] = [];
	const failures: unknown[] = [];
	let dispatched = 0;
	registerMonitorHooks(
		api as never,
		session,
		{
			dispatch: async (_ctx: unknown, event: HookEvent, names: string[], build: () => Record<string, unknown>) => {
				dispatched++;
				if (commandsFor(session.config, event, names).length > 0) runs.push({ event, rule: names[0], input: build() });
				return {};
			},
			reportFailure: (_ctx, _event, error) => failures.push(error),
		},
		{ now: () => 5000, ...options },
	);
	const ctx = { cwd, sessionManager: { getSessionId: () => "monitor-session" } };
	const ledger = monitorLedgerOf(api);
	return {
		ledger,
		runs,
		failures,
		dispatched: () => dispatched,
		start: () => handlers.get("session_start")!.at(-1)!({}, ctx),
		shutdown: () => Promise.all(handlers.get("session_shutdown")!.map((handler) => handler({}, ctx))),
		/** Resolves once the hook's subscription has read the whole log: every alert published so far reached its handler. */
		handled: () =>
			vi.waitFor(() => {
				const { db } = sharedAgentDb();
				const workspace = registeredWorkspace(cwd, sharedAgentDb()).id;
				const [row] = eventSubscriptions.forSubscriber(
					db,
					workspace,
					"hook:monitor-alert:hooks:monitor-session",
					Date.now(),
				);
				expect(row?.offset_seq).toBe(events.lastSeq(db, workspace));
			}),
	};
}

type Run = { event: string; rule: string; input: Record<string, unknown> };
const SENTINEL = "sentinel:";
let sentinels = 0;

/**
 * The hook runs of every alert recorded so far. An alert travels ledger, event log, subscription and a deferred
 * dispatch, in order, so this records one more alert and waits for its run: by then each earlier alert has had its turn,
 * and one that is absent did not run (rather than not yet).
 */
async function runsOf(h: ReturnType<typeof harness>): Promise<Run[]> {
	const subject = `${SENTINEL}${++sentinels}`;
	h.ledger.record({ rule: "job", value: 0, threshold: 0, subject }, true);
	await vi.waitFor(() => expect(h.runs.map((run) => run.input.subject)).toContain(subject));
	const end = h.runs.findIndex((run) => run.input.subject === subject);
	expect(h.runs.slice(end + 1)).toEqual([]);
	return h.runs.slice(0, end).filter((run) => !String(run.input.subject).startsWith(SENTINEL));
}

describe("MonitorAlert hook", () => {
	it("is a catalogued Octocode-only observer event", () => {
		expect(HOOK_EVENTS).toContain("MonitorAlert");
		expect(Object.keys(HOOK_CATALOG.MonitorAlert.profiles)).toEqual(["octocode"]);
	});

	it("runs the hook once per alert with the rule, reading, threshold, subject, time and delivery", async () => {
		const h = harness(undefined);
		await h.start();
		h.ledger.record({ rule: "job", value: 16, threshold: 15, subject: "job-1", at: 1234 }, true);
		h.ledger.record({ rule: "context", value: 75, threshold: 75 }, false);
		expect(await runsOf(h)).toEqual([
			{
				event: "MonitorAlert",
				rule: "job",
				input: { rule: "job", value: 16, threshold: 15, subject: "job-1", at: 1234, delivered: true },
			},
			{
				event: "MonitorAlert",
				rule: "context",
				input: { rule: "context", value: 75, threshold: 75, subject: null, at: 5000, delivered: false },
			},
		]);
	});

	it("selects hooks by the rule id", async () => {
		const h = harness("swap|job", { holdsSampler: () => true });
		await h.start();
		for (const { id } of ATTENTION_RULES) h.ledger.record({ rule: id, value: 1, threshold: 1 }, true);
		expect((await runsOf(h)).map((run) => run.rule)).toEqual(["swap", "job"]);
	});

	it("runs nothing without an alert, however the rules move", async () => {
		const h = harness(undefined);
		await h.start();
		h.ledger.trip("swap", true);
		h.ledger.trip("swap", false);
		expect(await runsOf(h)).toEqual([]);
	});

	it("runs a machine rule only in the process holding the sampler lease, and a session rule anywhere", async () => {
		let holds = false;
		const h = harness(undefined, { holdsSampler: () => holds });
		await h.start();
		h.ledger.record({ rule: "load", value: 4, threshold: 3 }, true);
		h.ledger.record({ rule: "job", value: 20, threshold: 15, subject: "j" }, true);
		expect((await runsOf(h)).map((run) => run.rule)).toEqual(["job"]);
		holds = true;
		h.ledger.record({ rule: "memory", value: 5, threshold: 10 }, true);
		expect((await runsOf(h)).map((run) => run.rule)).toEqual(["job", "memory"]);
	});

	it("runs nothing when no hook is configured", async () => {
		const h = harness(null);
		await h.start();
		h.ledger.record({ rule: "job", value: 1, threshold: 1 }, true);
		// No hook, so no run can stand in as a sentinel: the alert's own handling is the later event.
		await h.handled();
		expect(h.dispatched()).toBe(0);
		expect(h.runs).toEqual([]);
		expect(h.failures).toEqual([]);
	});

	it("stops listening at shutdown and does not stack on a second start", async () => {
		const h = harness(undefined);
		await h.start();
		await h.start();
		h.ledger.record({ rule: "job", value: 1, threshold: 1 }, true);
		expect((await runsOf(h)).map((run) => run.input.value)).toEqual([1]);
		await h.shutdown();
		h.ledger.record({ rule: "job", value: 2, threshold: 1 }, true);
		// A session that starts again hears what follows, and never the alert recorded while nothing listened.
		await h.start();
		h.ledger.record({ rule: "job", value: 3, threshold: 1 }, true);
		expect((await runsOf(h)).map((run) => run.input.value)).toEqual([1, 3]);
		await h.shutdown();
	});

	it("reports a failed lease check instead of dropping the alert silently", async () => {
		const h = harness(undefined, {
			holdsSampler: () => {
				throw new Error("database is locked");
			},
		});
		await h.start();
		h.ledger.record({ rule: "swap", value: 95, threshold: 90 }, true);
		expect(await runsOf(h)).toEqual([]);
		expect(h.failures).toHaveLength(1);
	});
});

describe("MonitorAlert replay", () => {
	const alerts = (h: ReturnType<typeof harness>) => {
		h.ledger.record({ rule: "job", value: 16, threshold: 15, subject: "job-1", at: 1234 }, true);
		h.ledger.record({ rule: "context", value: 75, threshold: 75 }, false);
	};
	const expected = [
		{
			event: "MonitorAlert",
			rule: "job",
			input: { rule: "job", value: 16, threshold: 15, subject: "job-1", at: 1234, delivered: true },
		},
		{
			event: "MonitorAlert",
			rule: "context",
			input: { rule: "context", value: 75, threshold: 75, subject: null, at: 5000, delivered: false },
		},
	];

	it("does not run an alert again after a restart of the session", async () => {
		const cwd = tmp();
		const first = harness(undefined, {}, cwd);
		await first.start();
		alerts(first);
		expect(await runsOf(first)).toEqual(expected);
		await first.shutdown();
		const second = harness(undefined, {}, cwd);
		await second.start();
		expect(await runsOf(second)).toEqual([]);
		expect(first.runs.filter((run) => !String(run.input.subject).startsWith(SENTINEL))).toEqual(expected);
		await second.shutdown();
	});
});
