import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, type MachineSample } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { tmp } from "../helpers.ts";
import type { MachineSamplerOptions } from "../../../src/octocode/monitor/sampler.ts";
import { monitorLedgerOf } from "../../../src/octocode/monitor/ledger.ts";
import { registerMonitor, statusText } from "../../../src/octocode/monitor/register.ts";
import { StuckJobWatch } from "../../../src/octocode/monitor/stuck-jobs.ts";

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "machine.db"));
});
afterEach(() => agent.close());

const hot = (at: number): MachineSample => ({
	at,
	load1: 48,
	load5: 30,
	load15: 30,
	cores: 12,
	memTotal: 100,
	memAvailable: 50,
	swapUsed: 0,
	swapTotal: 0,
	gpu: null,
	processes: [{ pid: 1, ppid: 0, command: "tsc", cpu: 900, rss: 1, owner: "octocode-agent-main-mine" }],
});

function setup(title: string, isSubagent = false, settings: Record<string, unknown> = {}) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const sent: Array<{ message: { content: string; display: boolean }; options: { triggerTurn?: boolean } }> = [];
	const status: Array<string | undefined> = [];
	const notices: string[] = [];
	let sampler: MachineSamplerOptions | undefined;
	const api = {
		bus: { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) },
		settings: { get: () => ({ monitor: { samples: 1, ...settings } }) },
		session: {
			sendMessage: (message: { content: string; display: boolean }, options: { triggerTurn?: boolean }) => {
				sent.push({ message, options });
			},
		},
	};
	const ctx = {
		hasUI: true,
		ui: { setStatus: (_key: string, text?: string) => status.push(text), notify: () => undefined },
	};
	registerMonitor(api as never, {
		isSubagent,
		jobs: () => [],
		notify: (notice) => notices.push(notice.title),
		db: () => agent.db,
		title: () => title,
		watch: new StuckJobWatch({ logSize: () => 0, groupCpu: async () => new Map() }),
		start: (options) => {
			sampler = options;
			return { tick: async () => undefined, stop: () => undefined };
		},
	});
	handlers.get("session_start")?.({}, ctx);
	return { api, sent, status, notices, sampler: () => sampler };
}

describe("monitor delivery", () => {
	it("wakes the session that owns the cause, and notifies the user from the publisher", () => {
		const mine = setup("octocode-agent-main-mine");
		mine.sampler()?.onSample(hot(60_000), true);
		expect(mine.sent).toHaveLength(1);
		expect(mine.sent[0].options.triggerTurn).toBe(true);
		expect(mine.sent[0].message.display).toBe(true);
		expect(mine.sent[0].message.content).toContain("tsc 900% CPU (octocode-agent-main-mine)");
		expect(mine.status).toEqual(["load 4"]);
		expect(mine.notices).toEqual(["Octocode: Load 4 per CPU"]);
	});

	it("gives another root session a footer mark and a ledger entry, nothing in its context", () => {
		const publisher = setup("octocode-agent-main-mine");
		const other = setup("octocode-agent-main-other");
		const recorded: Array<{ rule: string; delivered: boolean }> = [];
		monitorLedgerOf(other.api).subscribe((alert) => recorded.push({ rule: alert.rule, delivered: alert.delivered }));
		publisher.sampler()?.onSample(hot(60_000), true);
		other.sampler()?.onSample(hot(60_000), false);
		expect(other.sent).toEqual([]);
		expect(other.status).toEqual(["load 4"]);
		expect(other.notices).toEqual([]);
		expect(recorded).toEqual([{ rule: "load", delivered: true }]);
	});

	it("gives a child no note unless it owns a culprit, and never runs the rules in it", () => {
		const publisher = setup("octocode-agent-main-mine");
		const bystander = setup("octocode-agent-implementer-x", true);
		const owner = setup("octocode-agent-implementer-y", true);
		const rooted = (title: string) => ({ ...hot(60_000), processes: [{ ...hot(0).processes[0], owner: title }] });
		publisher.sampler()?.onSample(rooted("octocode-agent-implementer-y"), true);
		bystander.sampler()?.onSample(rooted("octocode-agent-implementer-y"), false);
		owner.sampler()?.onSample(rooted("octocode-agent-implementer-y"), false);
		expect(bystander.sent).toEqual([]);
		expect(bystander.status).toEqual([]);
		expect(owner.sent).toHaveLength(1);
		expect(owner.sent[0].options.triggerTurn).toBe(true);
		expect(publisher.sent).toEqual([]);
	});

	it("publishes a tripped threshold once, whichever session reads it", () => {
		const publisher = setup("octocode-agent-main-mine");
		const other = setup("octocode-agent-main-other");
		const recorded: string[] = [];
		monitorLedgerOf(other.api).subscribe((alert) => recorded.push(alert.rule));
		for (const at of [60_000, 120_000]) {
			publisher.sampler()?.onSample(hot(at), true);
			other.sampler()?.onSample(hot(at), false);
		}
		expect(publisher.sent).toHaveLength(1);
		expect(other.sent).toEqual([]);
		expect(recorded).toEqual(["load"]);
		expect(agent.db.prepare("SELECT COUNT(*) AS n FROM machine_alerts").get()).toEqual({ n: 1 });
	});

	it("a session that is not the publisher files nothing", () => {
		const other = setup("octocode-agent-main-other");
		other.sampler()?.onSample(hot(60_000), false);
		expect(agent.db.prepare("SELECT COUNT(*) AS n FROM machine_alerts").get()).toEqual({ n: 0 });
		expect(other.sent).toEqual([]);
	});

	it("has subagents read samples without taking them, and starts nothing when turned off", () => {
		expect(setup("octocode-agent-implementer-x", true).sampler()?.takesSamples).toBe(false);
		expect(setup("octocode-agent-main-mine").sampler()?.intervalMs).toBe(60_000);
		expect(setup("octocode-agent-main-mine", false, { enabled: false }).sampler()).toBeUndefined();
	});

	it("draws the footer mark from every active threshold", () => {
		expect(statusText([])).toBeUndefined();
		expect(
			statusText([
				{ rule: "swap", value: 92, threshold: 90 },
				{ rule: "load", value: 1.8, threshold: 1.5 },
			]),
		).toBe("swap 92% · load 1.8");
	});
});
