import { describe, expect, it } from "vitest";
import type { AgentLifecycleNotice } from "../../src/octocode/shared/agent-lifecycle.ts";
import { ChainQueue, MAX_QUEUED, openPrerequisites, type AfterHost } from "../../src/octocode/subagents/chain.ts";
import {
	type GateHost,
	type ItemStanding,
	parsePrerequisite,
	PrerequisiteGate,
} from "../../src/octocode/subagents/prerequisites.ts";
import { queueChild } from "../../src/octocode/subagents/queued-start.ts";
import { ChainLinks } from "../../src/octocode/hooks/register/chain.ts";

function setup(items: Record<string, ItemStanding> = {}) {
	const standing = { ...items };
	let listener: ((notice: AgentLifecycleNotice) => void) | undefined;
	let poke: (() => void) | undefined;
	const host: GateHost & { subscriptions: number } = {
		subscriptions: 0,
		item: (ref) => standing[ref] ?? "missing",
		lifecycle: (next) => {
			host.subscriptions++;
			listener = next;
			return () => {
				host.subscriptions--;
				listener = undefined;
			};
		},
		follow: (next) => {
			poke = next;
			return () => {
				poke = undefined;
			};
		},
	};
	const gate = new PrerequisiteGate(host);
	return {
		gate,
		host,
		standing,
		off: (agent: string, reason: string, outcome?: string, seq = 7) =>
			listener?.({
				seq,
				kind: "off",
				agent,
				parent: null,
				time: new Date().toISOString(),
				reason,
				data: outcome ? { outcome } : {},
			}),
		moved: () => poke?.(),
	};
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const never = () => new AbortController().signal;
const wait = (s: ReturnType<typeof setup>, names: string[], signal = never()) =>
	s.gate.wait(
		names.map((name) => parsePrerequisite(name)!),
		signal,
	);

describe("PrerequisiteGate", () => {
	it("is met for an item already done when the wait starts, with no subscription left", async () => {
		const s = setup({ B1: "done" });
		await expect(wait(s, ["B1"])).resolves.toEqual({ status: "met" });
		expect(s.host.subscriptions).toBe(0);
	});

	it("is met when an agent ends completed with outcome done, carrying the event's seq", async () => {
		const s = setup();
		const result = wait(s, ["agent:a"]);
		expect(s.host.subscriptions).toBe(1);
		s.off("a", "completed", "done", 41);
		await expect(result).resolves.toEqual({ status: "met", seq: 41 });
		expect(s.host.subscriptions).toBe(0);
	});

	it.each([
		["failed", undefined],
		["stopped-parent", undefined],
		["completed", "partial"],
		["completed", undefined],
	])("fails when the agent ends %s (outcome %s)", async (reason, outcome) => {
		const s = setup();
		const result = wait(s, ["agent:a", "B2"]);
		s.off("a", reason, outcome);
		const settled = await result;
		expect(settled.status).toBe("failed");
	});

	it("is met when an item completes in the database, and failed when it is closed or gone", async () => {
		const s = setup({ B1: "open", B2: "open" });
		const met = wait(s, ["B1"]);
		s.standing.B1 = "done";
		s.moved();
		await expect(met).resolves.toEqual({ status: "met" });
		const closed = wait(s, ["B2"]);
		s.standing.B2 = "closed";
		s.moved();
		await expect(closed).resolves.toMatchObject({ status: "failed", failed: [{ name: "B2" }] });
	});

	it("waits for every prerequisite, and prefers the parent's own record of an end to the retired row's", async () => {
		const s = setup({ B1: "open" });
		const result = wait(s, ["B1", "agent:a"]);
		s.gate.noteEnd("a", { reason: "completed", outcome: "done" });
		s.off("a", "completed", undefined);
		let settled = false;
		void result.then(() => (settled = true));
		await flush();
		expect(settled).toBe(false);
		s.standing.B1 = "done";
		s.moved();
		await expect(result).resolves.toMatchObject({ status: "met" });
	});

	it("ends a wait with the signal's reason and releases its subscription", async () => {
		const s = setup();
		const controller = new AbortController();
		const result = wait(s, ["agent:a"], controller.signal);
		controller.abort(new Error("stopped"));
		await expect(result).rejects.toThrow("stopped");
		expect(s.host.subscriptions).toBe(0);
	});
});

describe("after validation", () => {
	const host = (
		items: Record<string, { standing: ItemStanding; dependsOn: string[] }>,
		live: string[] = [],
	): AfterHost => ({
		item: (ref) => items[ref] ?? { standing: "missing", dependsOn: [] },
		liveChild: (id) => live.includes(id),
	});
	const queue = (gate = setup({ B2: "open", B12: "open", B14: "open", B20: "open" }).gate) =>
		new ChainQueue(gate, () => undefined);

	it("returns the open prerequisites and drops met ones", () => {
		const s = setup({ B1: "open", B2: "done" });
		const open = openPrerequisites(
			host({ B1: { standing: "open", dependsOn: [] }, B2: { standing: "done", dependsOn: [] } }, ["a"]),
			queue(s.gate),
			["B1", "B2", "agent:a"],
			"B9",
			[],
		);
		expect(open.map((each) => (each.kind === "item" ? each.ref : each.id))).toEqual(["B1", "a"]);
	});

	it("refuses a cycle through dependsOn (V2) and through queued children", () => {
		const items = {
			B12: { standing: "open" as const, dependsOn: ["B14"] },
			B14: { standing: "open" as const, dependsOn: [] },
		};
		expect(() => openPrerequisites(host(items), queue(), ["B12"], "B14", [])).toThrow(/Cycle/);
		const chain = queue();
		chain.add({ id: "q", role: "x", goal: "g", item: "B20", after: ["B14"], release: () => undefined });
		expect(() =>
			openPrerequisites(host({ ...items, B20: { standing: "open", dependsOn: [] } }), chain, ["B20"], "B14", []),
		).toThrow(/Cycle/);
	});

	it("refuses unknown shapes, missing or closed items, foreign agents, itself and a full queue", () => {
		const items = {
			B1: { standing: "closed" as const, dependsOn: [] },
			B2: { standing: "open" as const, dependsOn: [] },
		};
		const call =
			(names: string[], item = "B9", chain = queue()) =>
			() =>
				openPrerequisites(host(items), chain, names, item, []);
		expect(call(["nope"])).toThrow(/neither a backlog item/);
		expect(call(["B404"])).toThrow(/does not exist/);
		expect(call(["B1"])).toThrow(/closed without completion/);
		expect(call(["agent:stranger"])).toThrow(/not a child this session started/);
		expect(call(["B9"])).toThrow(/cannot wait for itself/);
		expect(call(Array.from({ length: 9 }, (_, i) => `B${i}`))).toThrow(/at most 8/);
		const full = queue();
		for (let i = 0; i < MAX_QUEUED; i++)
			full.add({ id: `q${i}`, role: "x", goal: "g", after: ["B2"], release: () => undefined });
		expect(call(["B2"], "B9", full)).toThrow(/at most 12/);
	});
});

describe("a queued child", () => {
	const spec = (prepare = () => undefined) => ({
		id: "kelp",
		role: "general",
		goal: "g",
		item: "B14",
		after: [parsePrerequisite("B12")!],
		prepare,
		onHeld: () => undefined,
	});

	it("is listed with what it waits for, then held with why, and starts when told", async () => {
		const s = setup({ B12: "open" });
		const told: string[] = [];
		const chain = new ChainQueue(s.gate, () => undefined);
		const queued = queueChild(chain, (notice) => told.push(notice), spec());
		expect(chain.rows()).toEqual(["kelp queued on B14 after B12"]);
		const started = queued.wait(never());
		s.standing.B12 = "closed";
		s.moved();
		await flush();
		expect(chain.rows()[0]).toMatch(/^kelp held on B14: B12 was closed without completion/);
		expect(told).toHaveLength(1);
		expect(told[0]).toContain("kelp's queued start on B14 is held");
		expect(chain.start("kelp")).toBeUndefined();
		await expect(started).resolves.toEqual({});
		queued.finish();
		expect(chain.size).toBe(0);
		expect(chain.start("kelp")).toMatch(/not a queued child/);
	});

	it("holds when its start is refused, and starts when told", async () => {
		const s = setup({ B12: "done" });
		let refuse = true;
		const chain = new ChainQueue(s.gate, () => undefined);
		const queued = queueChild(
			chain,
			() => undefined,
			spec(() => {
				if (refuse) throw new Error("B14 is held by another session");
			}),
		);
		const controller = new AbortController();
		const started = queued.wait(controller.signal);
		await flush();
		expect(chain.get("kelp")?.held).toContain("its start was refused: B14 is held by another session");
		refuse = false;
		chain.start("kelp");
		await expect(started).resolves.toEqual({});
	});
});

describe("hook chain links", () => {
	it("gives AgentOn started_after and AgentOff the children it released and held", () => {
		const links = new ChainLinks();
		links.note({ kind: "released", agent: "kelp", role: "general", after: ["B12", "agent:sly"], seq: 9 });
		links.note({ kind: "held", agent: "moss", role: "general", after: ["agent:sly"], failed: ["agent:sly"] });
		expect(links.on("kelp")).toEqual({ started_after: { prerequisites: ["B12", "agent:sly"], seq: 9 } });
		expect(links.on("someone")).toEqual({});
		expect(links.off("sly")).toEqual({ releases: ["kelp"], holds: ["moss"] });
		expect(links.off("other")).toEqual({ releases: [], holds: [] });
	});
});
