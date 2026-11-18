import { describe, expect, it } from "vitest";
import type { MachineSample } from "../../../../db/src/api.ts";
import { attend } from "../../../src/octocode/monitor/attention/attend.ts";
import { ATTENTION_RULES } from "../../../src/octocode/monitor/attention/rules.ts";
import { type Attention, monitorLedgerOf } from "../../../src/octocode/monitor/ledger.ts";
import { registerMonitor } from "../../../src/octocode/monitor/register.ts";
import type { MachineSamplerOptions } from "../../../src/octocode/monitor/sampler.ts";
import { StuckJobWatch } from "../../../src/octocode/monitor/stuck-jobs.ts";

const sample = (at: number, load1: number): MachineSample => ({
	at,
	load1,
	load5: 1,
	load15: 1,
	cores: 12,
	memTotal: 100,
	memAvailable: 50,
	swapUsed: 0,
	swapTotal: 0,
	gpu: null,
	processes: [{ pid: 1, ppid: 0, command: "tsc", cpu: 900, rss: 1, owner: "octocode-main-mine" }],
});

function monitored(sendMessage: (message: unknown, options: unknown) => unknown = () => undefined) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let sampler: MachineSamplerOptions | undefined;
	const api = {
		bus: { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) },
		settings: { get: () => ({ monitor: { samples: 1, cooldownMinutes: 0 } }) },
		session: { sendMessage },
	};
	registerMonitor(api as never, {
		isSubagent: false,
		jobs: () => [],
		db: () => ({}) as never,
		title: () => "octocode-main-mine",
		watch: new StuckJobWatch({ logSize: () => 0, groupCpu: async () => new Map() }),
		start: (options) => {
			sampler = options;
			return { tick: async () => undefined, stop: () => undefined };
		},
	});
	handlers.get("session_start")?.({}, { hasUI: false, ui: { notify: () => undefined } });
	return { api, sample: (at: number, load: number) => sampler!.onSample(sample(at, load), true) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("monitor ledger", () => {
	it("starts with every rule ok, in registry order", () => {
		const rules = monitorLedgerOf({}).rules();
		expect(rules.map((rule) => rule.rule)).toEqual(ATTENTION_RULES.map((rule) => rule.id));
		expect(rules.every((rule) => rule.state === "ok" && rule.trips === 0 && rule.alerts === 0)).toBe(true);
	});

	it("counts machine alerts, reads ok once the threshold clears, and tells subscribers", async () => {
		const m = monitored();
		const heard: Array<Attention & { delivered: boolean }> = [];
		const stop = monitorLedgerOf(m.api).subscribe((alert) => heard.push(alert));
		m.sample(60_000, 48);
		await settle();
		const load = () =>
			monitorLedgerOf(m.api)
				.rules()
				.find((rule) => rule.rule === "load")!;
		expect(load()).toMatchObject({ state: "tripped", alerts: 1, lastValue: 4, threshold: 3, lastAlertAt: 60_000 });
		m.sample(120_000, 1);
		await settle();
		expect(load().state).toBe("ok");
		m.sample(180_000, 48);
		await settle();
		expect(load()).toMatchObject({ state: "tripped", alerts: 2, lastAlertAt: 180_000 });
		expect(heard.map((alert) => [alert.rule, alert.value, alert.delivered])).toEqual([
			["load", 4, true],
			["load", 4, true],
		]);
		stop();
		m.sample(240_000, 1);
		m.sample(300_000, 48);
		await settle();
		expect(heard).toHaveLength(2);
		expect(load().alerts).toBe(3);
	});

	it("records an undelivered alert without counting it as an alert", async () => {
		const m = monitored(() => Promise.reject(new Error("This session is stale after session replacement")));
		const heard: boolean[] = [];
		monitorLedgerOf(m.api).subscribe((alert) => heard.push(alert.delivered));
		m.sample(60_000, 48);
		await settle();
		const load = monitorLedgerOf(m.api)
			.rules()
			.find((rule) => rule.rule === "load")!;
		expect(load).toMatchObject({ state: "tripped", alerts: 0, lastValue: 4 });
		expect(heard).toEqual([false]);
	});

	it("counts what attend delivers, swallows a stale session and rethrows any other failure", async () => {
		let fail: Error | undefined;
		const api = {
			session: {
				sendMessage: () => {
					if (fail) throw fail;
				},
			},
		};
		const attention: Attention = { rule: "idle-agent", value: 12, threshold: 10, subject: "c-1", at: 5 };
		const message = { customType: "x", content: "y" };
		await expect(attend(api, attention, message, { how: "note" })).resolves.toBe(true);
		fail = new Error("This session is stale after session replacement");
		await expect(attend(api, attention, message, { how: "wake" })).resolves.toBe(false);
		fail = new Error("disk full");
		expect(() => attend(api, attention, message, { how: "note" })).toThrow("disk full");
		expect(
			monitorLedgerOf(api)
				.rules()
				.find((rule) => rule.rule === "idle-agent"),
		).toMatchObject({
			state: "tripped",
			trips: 2,
			alerts: 1,
			lastAlertAt: 5,
			subject: "c-1",
		});
	});

	it("refuses a rule that is not in the registry", () => {
		const ledger = monitorLedgerOf({});
		expect(() => ledger.trip("nope" as never, true)).toThrow(/No monitor rule/);
		expect(() => ledger.record({ rule: "nope" as never, value: 1, threshold: 1 }, true)).toThrow(/No monitor rule/);
	});
});
