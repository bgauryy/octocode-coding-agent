import { describe, expect, it } from "vitest";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { emptyHooks } from "../../src/octocode/hooks/config/parse.ts";
import { HOOK_CATALOG, HOOK_EVENTS, type HookEvent } from "../../src/octocode/hooks/catalog.ts";
import { registerMonitorHooks, type MonitorHookOptions } from "../../src/octocode/hooks/register/monitor.ts";
import type { HookSession } from "../../src/octocode/hooks/register/types.ts";
import { ATTENTION_RULES } from "../../src/octocode/monitor/attention/rules.ts";
import { monitorLedgerOf } from "../../src/octocode/monitor/ledger.ts";

/**
 * A session with one MonitorAlert group, a real ledger and a dispatch that runs a hook only when the configured matcher
 * selects the rule (`commandsFor`, the dispatcher's own selection), so what it records is what a user's hook would see.
 */
function harness(matcher: string | undefined | null, options: MonitorHookOptions = {}) {
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
	const runs: Array<{ event: string; rule: string; input: Record<string, unknown> }> = [];
	const failures: unknown[] = [];
	registerMonitorHooks(
		api as never,
		session,
		{
			dispatch: async (_ctx: unknown, event: HookEvent, names: string[], build: () => Record<string, unknown>) => {
				if (commandsFor(session.config, event, names).length > 0) runs.push({ event, rule: names[0], input: build() });
				return {};
			},
			reportFailure: (_ctx, _event, error) => failures.push(error),
		},
		{ now: () => 5000, ...options },
	);
	const ledger = monitorLedgerOf(api);
	return {
		ledger,
		runs,
		failures,
		start: () => handlers.get("session_start")!.at(-1)!({}, {}),
		shutdown: () => Promise.all(handlers.get("session_shutdown")!.map((handler) => handler({}, {}))),
		flush: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
	};
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
		await h.flush();
		expect(h.runs).toEqual([
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
		await h.flush();
		expect(h.runs.map((run) => run.rule)).toEqual(["swap", "job"]);
	});

	it("runs nothing without an alert, however the rules move", async () => {
		const h = harness(undefined);
		await h.start();
		h.ledger.trip("swap", true);
		h.ledger.trip("swap", false);
		await h.flush();
		expect(h.runs).toEqual([]);
	});

	it("runs a machine rule only in the process holding the sampler lease, and a session rule anywhere", async () => {
		let holds = false;
		const h = harness(undefined, { holdsSampler: () => holds });
		await h.start();
		h.ledger.record({ rule: "load", value: 4, threshold: 3 }, true);
		h.ledger.record({ rule: "job", value: 20, threshold: 15, subject: "j" }, true);
		await h.flush();
		expect(h.runs.map((run) => run.rule)).toEqual(["job"]);
		holds = true;
		h.ledger.record({ rule: "memory", value: 5, threshold: 10 }, true);
		await h.flush();
		expect(h.runs.map((run) => run.rule)).toEqual(["job", "memory"]);
	});

	it("runs nothing when no hook is configured", async () => {
		const h = harness(null);
		await h.start();
		h.ledger.record({ rule: "job", value: 1, threshold: 1 }, true);
		await h.flush();
		expect(h.runs).toEqual([]);
		expect(h.failures).toEqual([]);
	});

	it("stops listening at shutdown and does not stack on a second start", async () => {
		const h = harness(undefined);
		await h.start();
		await h.start();
		h.ledger.record({ rule: "job", value: 1, threshold: 1 }, true);
		await h.flush();
		expect(h.runs).toHaveLength(1);
		await h.shutdown();
		h.ledger.record({ rule: "job", value: 2, threshold: 1 }, true);
		await h.flush();
		expect(h.runs).toHaveLength(1);
	});

	it("reports a failed lease check instead of dropping the alert silently", async () => {
		const h = harness(undefined, {
			holdsSampler: () => {
				throw new Error("database is locked");
			},
		});
		await h.start();
		h.ledger.record({ rule: "swap", value: 95, threshold: 90 }, true);
		await h.flush();
		expect(h.runs).toEqual([]);
		expect(h.failures).toHaveLength(1);
	});
});
