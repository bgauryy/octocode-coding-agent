import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../../db/src/api.ts";
import { SettingsSchema } from "../../../src/core/settings-schema.ts";
import { MONITOR_DEFAULTS } from "../../../src/core/settings-schema/monitor.ts";
import { openBacklog } from "../../../src/octocode/backlog/context.ts";
import { CheckIn, checkInConfig, checkInSeconds } from "../../../src/octocode/monitor/attention/check-in.ts";
import {
	CONTEXT_NOTICE_TYPE,
	contextBands,
	noticeContextUsage,
} from "../../../src/octocode/monitor/attention/context.ts";
import { ATTENTION_RULES } from "../../../src/octocode/monitor/attention/rules.ts";
import { monitorLedgerOf } from "../../../src/octocode/monitor/ledger.ts";
import { registerIdleItems } from "../../../src/octocode/subagents/idle-items.ts";
import type { Team } from "../../../src/octocode/team/session.ts";
import { type AgentEvent, describeEvent } from "../../../src/octocode/wake/catalog.ts";
import { wakeGateOf } from "../../../src/octocode/wake/gate.ts";
import { registerWake } from "../../../src/octocode/wake/register.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";

const MIN = 60_000;
const READY = { goal: "Expected result", why: "Required work" };

let tmp: string;
let savedDb: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-attention-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("context bands", () => {
	const model = { provider: "anthropic", id: "claude-x", contextWindow: 200_000 };
	function session() {
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
		const entries: Array<{ message: unknown }> = [];
		const api = {
			session: {
				sendMessage: (message: Record<string, unknown>, options: unknown) => {
					sent.push({ message, options });
					entries.push({ message: { role: "custom", ...message } });
				},
			},
		};
		let tokens = 0;
		const ctx = { model, getContextUsage: () => ({ tokens }) };
		const at = (next: number, bands?: readonly number[], compactionId?: string, from = entries) => {
			tokens = next;
			return noticeContextUsage(api, ctx as never, from, undefined, false, compactionId, bands);
		};
		return {
			api,
			sent,
			entries,
			at,
			bands: () => sent.map((entry) => (entry.message.details as { band: number }).band),
		};
	}

	it("tells each band once, as a hidden note that starts no turn, and records it", async () => {
		const s = session();
		const bands = [0.5, 0.75, 0.9];
		// The limit before automatic compaction is below the window; 100k of 200k is past half of it.
		for (const tokens of [10_000, 100_000, 100_000, 140_000, 175_000, 175_000]) s.at(tokens, bands);
		expect(s.bands()).toEqual(bands);
		for (const { message, options } of s.sent) {
			expect(message).toMatchObject({ customType: CONTEXT_NOTICE_TYPE, display: false });
			expect(options).toEqual({ triggerTurn: false });
		}
		const details = s.sent[0].message.details as { tokens: number; limit: number; compactionId: null };
		expect(details).toMatchObject({ tokens: 100_000, compactionId: null });
		await settle();
		const context = monitorLedgerOf(s.api)
			.rules()
			.find((rule) => rule.rule === "context")!;
		expect(context).toMatchObject({ alerts: 3, threshold: 90, lastValue: Math.round((175_000 / details.limit) * 100) });
	});

	it("does not repeat a band after a resume, and starts over after a compaction", () => {
		const first = session();
		first.at(180_000, undefined, "c-1");
		const resumed = session();
		resumed.at(180_000, undefined, "c-1", first.entries);
		expect(resumed.sent).toEqual([]);
		resumed.at(180_000, undefined, "c-2", first.entries);
		expect(resumed.bands()).toEqual([0.9]);
		expect(resumed.sent[0].message.details).toMatchObject({ compactionId: "c-2" });
	});

	it("tells the model only once automatic compaction is near, by default", () => {
		const s = session();
		for (const tokens of [100_000, 140_000]) s.at(tokens);
		expect(s.sent).toEqual([]);
		s.at(180_000);
		expect(s.bands()).toEqual([0.9]);
	});

	it("sends nothing with no bands, sorts unsorted ones, and falls back on invalid ones", () => {
		const off = session();
		expect(off.at(175_000, contextBands({ monitor: { contextBands: [] } }))).toBeUndefined();
		expect(off.sent).toEqual([]);
		expect(contextBands({ monitor: { contextBands: [0.9, 0.6] } })).toEqual([0.6, 0.9]);
		for (const invalid of [[0.5, 1], [0], [-0.2], [Number.NaN], "0.5"])
			expect(contextBands({ monitor: { contextBands: invalid as never } })).toEqual(MONITOR_DEFAULTS.contextBands);
		expect(contextBands(undefined)).toEqual(MONITOR_DEFAULTS.contextBands);
		const custom = session();
		custom.at(130_000, contextBands({ monitor: { contextBands: [0.9, 0.6] } }));
		expect(custom.bands()).toEqual([0.6]);
	});

	it("ignores a model with a 0-token window", () => {
		const sent: unknown[] = [];
		const api = { session: { sendMessage: (message: unknown) => sent.push(message) } };
		const ctx = { model: { ...model, contextWindow: 0 }, getContextUsage: () => ({ tokens: 1_000_000 }) };
		expect(noticeContextUsage(api as never, ctx as never, [])).toBeUndefined();
		expect(sent).toEqual([]);
	});
});

describe("check-in", () => {
	const ON = { seconds: 300, parentWaits: false };
	function checkIn(lastExchange = () => 0) {
		const notice = vi.fn((_text: string) => true);
		const record = vi.fn();
		return { notice, record, ping: new CheckIn({ notice, lastExchange, record }) };
	}

	it("is not told before the interval, or while the child waits on its own work", () => {
		const { notice, ping } = checkIn();
		ping.begin(0);
		ping.due("c-1", "p-1", ON, 5 * MIN - 1);
		ping.due("c-1", "p-1", { ...ON, busy: true }, 60 * MIN);
		expect(notice).not.toHaveBeenCalled();
	});

	it("is told once, then re-armed by a message, and records each ping", () => {
		let talked = 0;
		const { notice, record, ping } = checkIn(() => talked);
		ping.begin(0);
		ping.due("c-1", "p-1", ON, 5 * MIN);
		ping.due("c-1", "p-1", ON, 6 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenLastCalledWith(
			{ rule: "check-in", value: 300, threshold: 300, subject: "p-1", at: 5 * MIN },
			true,
		);
		talked = 8 * MIN;
		ping.due("c-1", "p-1", ON, 12 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
		ping.due("c-1", "p-1", ON, 13 * MIN);
		expect(notice).toHaveBeenCalledTimes(2);
	});

	it("records a ping the session could not take as undelivered, and tries again", () => {
		const { notice, record, ping } = checkIn();
		notice.mockReturnValueOnce(false);
		ping.begin(0);
		ping.due("c-1", "p-1", ON, 5 * MIN);
		ping.due("c-1", "p-1", ON, 5 * MIN + 1);
		expect(record.mock.calls.map((call) => call[1])).toEqual([false, true]);
	});

	it("reads monitor.checkInSeconds, 0 included, and takes the default for a refused value", () => {
		expect(checkInSeconds({ monitor: { checkInSeconds: 60 } })).toBe(60);
		expect(checkInSeconds({ monitor: { checkInSeconds: 0 } })).toBe(0);
		expect(checkInSeconds({ monitor: { checkInSeconds: -1 } })).toBe(300);
		expect(checkInSeconds(undefined)).toBe(300);
		expect(checkInConfig({ monitor: { checkInSeconds: 120 } }, true)).toEqual({
			seconds: 120,
			parentWaits: true,
			busy: false,
		});
	});
});

describe("idle items", () => {
	function setup() {
		const fake = fakeHost();
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd });
		registerWake(fake.api);
		const runs = { running: new Map<string, undefined>([["child", undefined]]), items: new Map<string, string>() };
		registerIdleItems(fake.api, { reserved: () => false } as unknown as Team, runs, { onItem: () => undefined });
		const gate = wakeGateOf(fake.api);
		const emitted: AgentEvent[] = [];
		const emit = gate.emit.bind(gate);
		vi.spyOn(gate, "emit").mockImplementation((events, ...rest) => {
			emitted.push(...(Array.isArray(events) ? events : [events]));
			return emit(events, ...rest);
		});
		const backlog = openBacklog(ctx, { isSubagent: false });
		const hold = (title: string) => {
			const item = backlog.store.add({ ...READY, title, state: "todo", createdBy: "user" });
			return backlog.store.update(item.ref, { state: "ongoing" }, backlog.actor).ref;
		};
		const run = async (during?: () => Promise<void>) => {
			await fake.emit("agent_start", {}, ctx);
			await during?.();
			await fake.emit("agent_settled", { aborted: false }, ctx);
		};
		const note = (ref: string) => async () => {
			await fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "backlog", args: { op: "note", id: ref } },
				ctx,
			);
			await fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "backlog", isError: false }, ctx);
		};
		const nudges = () => fake.sent.filter((entry) => entry.message.customType === "octocode-idle-item");
		return { fake, gate, emitted, hold, run, note, nudges };
	}

	it("wakes once per wait with monitor.alert idle-items, labelled and keyed by its refs", async () => {
		const s = setup();
		const a = s.hold("a");
		const b = s.hold("b");
		await s.run();
		await s.run();
		expect(s.nudges()).toHaveLength(1);
		expect(s.nudges()[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(s.nudges()[0].message.display).toBe(false);
		const alerts = s.emitted.filter((event) => event.kind === "monitor.alert");
		expect(alerts).toHaveLength(1);
		const alert = alerts[0];
		if (alert.kind !== "monitor.alert") throw new Error("expected a monitor alert");
		expect(alert).toMatchObject({ rule: "idle-items", value: 2, threshold: 0 });
		const refs = alert.subject!.split(",");
		expect([...refs].sort()).toEqual([a, b].sort());
		expect(describeEvent(alert)).toEqual({
			label: `${refs.join(", ")} idle: you hold it, nothing works on it`,
			key: `idle:${[...refs].sort().join(",")}`,
		});
		await settle();
		expect(
			monitorLedgerOf(s.fake.api)
				.rules()
				.find((rule) => rule.rule === "idle-items"),
		).toMatchObject({ alerts: 1, lastValue: 2 });
	});

	it("drops an acted-on ref and tells it after a later run that did nothing about it", async () => {
		const s = setup();
		const ref = s.hold("noted");
		await s.run(s.note(ref));
		expect(s.nudges()).toHaveLength(0);
		expect(s.gate.droppedCount()).toBe(1);
		await s.run();
		expect(s.nudges()).toHaveLength(1);
		expect(s.emitted.at(-1)).toMatchObject({ kind: "monitor.alert", rule: "idle-items", subject: ref });
	});

	it("names nothing when no work runs", async () => {
		const s = setup();
		s.hold("free");
		await s.fake.emit("agent_settled", { aborted: true }, fakeCtx({ cwd: tmp }));
		expect(s.nudges()).toEqual([]);
	});
});

describe("the rule registry", () => {
	const docs = fs.readFileSync(
		path.join(path.dirname(new URL(import.meta.url).pathname), "../../../docs/configuration.md"),
		"utf8",
	);
	const section = docs.slice(docs.indexOf("### Attention rules"));
	const schemaHas = (key: string) => {
		let node: unknown = SettingsSchema;
		for (const part of key.split(".")) {
			const properties = (node as { properties?: Record<string, unknown> }).properties;
			node = properties?.[part];
			if (!node) return false;
		}
		return typeof (node as { description?: unknown }).description === "string";
	};

	it("has unique ids, each setting described in the schema, and a row in the configuration docs", () => {
		const ids = ATTENTION_RULES.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(section.length).toBeGreaterThan(0);
		for (const rule of ATTENTION_RULES) {
			for (const key of rule.settings) expect(schemaHas(key), key).toBe(true);
			const row = section.split("\n").find((line) => line.startsWith("|") && line.includes(`\`${rule.id}\``));
			expect(row, rule.id).toBeDefined();
			for (const key of rule.settings.filter((setting) => setting.startsWith("monitor.")))
				expect(row, `${rule.id} names ${key}`).toContain(key);
		}
	});
});
