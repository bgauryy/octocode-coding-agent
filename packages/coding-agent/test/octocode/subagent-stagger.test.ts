import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { PrefixStagger, staggeredLaunch, staggerPays, type StaggerTurn } from "../../src/octocode/subagents/stagger.ts";

/**
 * A child whose process starts when launched (`spawned`), whose first request goes out once its turn is ready
 * (`log`: "start <name>"), and whose first reply starts when the test says so.
 */
function fakeChild(log: string[], name: string, spawned: string[] = []) {
	let warm: () => void = () => undefined;
	let lost: () => void = () => undefined;
	let finish: (outcome: string) => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	const done = new Promise<string>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	return {
		start: (turn: StaggerTurn) => {
			spawned.push(name);
			warm = turn.warm;
			lost = turn.lost;
			turn.ready().then(() => log.push(`start ${name}`), fail);
			return done;
		},
		reply: () => warm(),
		/** The child's process exited before its first reply (a crash, a start that is retried). */
		exit: () => lost(),
		finish,
		fail,
	};
}

const leadersOf = (stagger: PrefixStagger) => (stagger as unknown as { leaders: Map<string, unknown> }).leaders;

describe("PrefixStagger", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("boots every child at once; the siblings send after the first child's first reply starts", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const spawned: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name, spawned));
		void stagger.run("researcher|m", undefined, a.start);
		void stagger.run("researcher|m", undefined, b.start);
		void stagger.run("researcher|m", undefined, c.start);
		// The processes boot together: only the first request waits.
		expect(spawned).toEqual(["a", "b", "c"]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(log).toEqual(["start a"]);
		a.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
	});

	it("holds siblings while the first child is alive and working, with no time bound", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		void stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(log).toEqual(["start a"]);
		expect(vi.getTimerCount()).toBe(0);
		a.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
	});

	it("releases siblings when the first child's process exits before its reply; its retried start waits like a sibling", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		void stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		a.exit();
		await vi.advanceTimersByTimeAsync(0);
		// The next child to ask leads; the third waits for its reply.
		expect(log).toEqual(["start a", "start b"]);
		b.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
	});

	it("does nothing when a sibling that is not the first exits", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		void stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		b.exit();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a"]);
		a.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
	});

	it("releases siblings when the first child ends without a reply, the next becoming the first", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		const first = stagger.run("k", undefined, a.start);
		const second = stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		a.fail(new Error("startup failed"));
		await expect(first).rejects.toThrow("startup failed");
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b"]);
		b.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
		b.finish("ok");
		await expect(second).resolves.toBe("ok");
	});

	it("keeps a prefix warm for the child's own cache lifetime, not a fixed four minutes", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, c, d] = ["a", "c", "d"].map((name) => fakeChild(log, name));
		const HOUR = 3_600_000;
		void stagger.run("k", undefined, a.start, HOUR);
		a.reply();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		// Ten minutes later the one-hour entry is still warm: both start at once, nobody waits for a first reply.
		void stagger.run("k", undefined, c.start, HOUR);
		void stagger.run("k", undefined, d.start, HOUR);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start c", "start d"]);
		// A five-minute entry has lapsed by then: the next child leads and its sibling waits for its reply.
		const short = new PrefixStagger();
		const log2: string[] = [];
		const [e, f, g] = ["e", "f", "g"].map((name) => fakeChild(log2, name));
		void short.run("k", undefined, e.start, 300_000);
		e.reply();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		void short.run("k", undefined, f.start, 300_000);
		void short.run("k", undefined, g.start, 300_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(log2).toEqual(["start e", "start f"]);
	});

	it("does not delay children of another prefix, nor children of a warm prefix", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, other, later] = ["a", "b", "other", "later"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		void stagger.run("k", undefined, b.start);
		void stagger.run("different", undefined, other.start);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start other"]);
		a.reply();
		await vi.advanceTimersByTimeAsync(0);
		void stagger.run("k", undefined, later.start);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start other", "start b", "start later"]);
	});

	it("treats the prefix as cold again once the cache entry could have lapsed", async () => {
		const stagger = new PrefixStagger(60_000);
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		a.reply();
		a.finish("done");
		await vi.advanceTimersByTimeAsync(61_000);
		void stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b"]);
	});

	it("cancels a waiting child on abort without sending its request, leaving the others to go on", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		const stop = new AbortController();
		void stagger.run("k", undefined, a.start);
		const stopped = stagger.run("k", stop.signal, b.start);
		const survivor = stagger.run("k", undefined, c.start);
		stop.abort();
		await expect(stopped).rejects.toThrow("Subagent cancelled");
		a.reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start c"]);
		c.finish("ok");
		await expect(survivor).resolves.toBe("ok");
	});

	it("rejects at once for a signal that is already aborted, starting nothing", async () => {
		const stagger = new PrefixStagger();
		const stop = new AbortController();
		stop.abort();
		const start = vi.fn(() => Promise.resolve("never"));
		await expect(stagger.run("k", stop.signal, start)).rejects.toThrow("Subagent cancelled");
		expect(start).not.toHaveBeenCalled();
	});

	it("never makes a run that already ended the first: a later sibling is not held by a dead run", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, f, g] = ["a", "f", "g"].map((name) => fakeChild(log, name));
		const first = stagger.run("k", undefined, a.start);
		// The sibling's run ends (its result, a failure, a cancel) while its wait for the first child is still pending.
		const follower = stagger.run("k", undefined, f.start);
		f.finish("gone");
		await expect(follower).resolves.toBe("gone");
		// The first child is lost: the dead sibling's wait wakes, and must not take the prefix for its ended run.
		a.exit();
		await vi.advanceTimersByTimeAsync(0);
		void stagger.run("k", undefined, g.start);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start g"]);
		a.finish("done");
		g.finish("done");
		await first;
		await vi.advanceTimersByTimeAsync(0);
		expect(leadersOf(stagger).size).toBe(0);
	});

	it("leaves no first child behind once every run ended, whatever order runs reply, exit, fail or abort in", async () => {
		for (let seed = 1; seed <= 40; seed++) {
			let state = seed;
			const random = (n: number) => {
				state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
				return state % n;
			};
			const stagger = new PrefixStagger();
			const log: string[] = [];
			const children = Array.from({ length: 6 }, (_, index) => {
				const child = fakeChild(log, `c${index}`);
				const stop = new AbortController();
				const run = stagger.run(random(2) === 0 ? "k" : "j", stop.signal, child.start).catch(() => undefined);
				return { child, stop, run, ended: false };
			});
			for (let step = 0; step < 30; step++) {
				const pick = children[random(children.length)];
				const action = random(5);
				if (action === 0) pick.child.reply();
				else if (action === 1) pick.child.exit();
				else if (pick.ended) continue;
				else {
					pick.ended = true;
					if (action === 2) pick.child.finish("ok");
					else if (action === 3) pick.child.fail(new Error("crash"));
					else pick.stop.abort();
				}
				await vi.advanceTimersByTimeAsync(random(3));
			}
			for (const pick of children) pick.child.finish("ok");
			await Promise.all(children.map((pick) => pick.run));
			await vi.advanceTimersByTimeAsync(0);
			expect(leadersOf(stagger).size, `seed ${seed}`).toBe(0);
		}
	});
});

const model = (cost: Model<Api>["cost"], api: Api = "anthropic-messages"): Model<Api> => ({
	id: "m",
	name: "m",
	api,
	provider: "p",
	baseUrl: "https://example.invalid",
	input: ["text"],
	cost,
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 8_000,
});

describe("staggerPays", () => {
	it("staggers where a cache read costs less than the request that writes the entry", () => {
		expect(staggerPays(model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), undefined)).toBe(true);
		// No write premium (the write is billed as input): a read still costs less.
		expect(
			staggerPays(model({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, "openai-responses"), undefined),
		).toBe(true);
	});

	it("does not stagger a model without cache prices, or one whose read costs as much as the write", () => {
		expect(staggerPays(model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined)).toBe(false);
		expect(staggerPays(model({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined)).toBe(false);
		expect(staggerPays(model({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined)).toBe(false);
		// A hand-written model entry without prices.
		expect(
			staggerPays(
				{ ...model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), cost: undefined } as never,
				undefined,
			),
		).toBe(false);
	});

	it("does not stagger when the request cannot hit a cache", () => {
		const priced = model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(staggerPays(priced, { cacheRetention: "none" })).toBe(false);
		expect(staggerPays(model(priced.cost, "unknown-api"), undefined)).toBe(false);
	});
});

describe("staggeredLaunch", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("never holds a child whose siblings would not save by waiting", async () => {
		const log: string[] = [];
		const children = ["a", "b", "c"].map((name) => fakeChild(log, name));
		for (const child of children)
			void staggeredLaunch("free|m", undefined, (_signal, _update, turn) => child.start(turn), false)()(undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b", "start c"]);
	});

	it("holds the siblings of a priced prefix until the first child's reply starts", async () => {
		const log: string[] = [];
		const children = ["a", "b"].map((name) => fakeChild(log, name));
		for (const child of children)
			void staggeredLaunch("priced|m", undefined, (_signal, _update, turn) => child.start(turn), true)()(undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a"]);
		children[0].reply();
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toEqual(["start a", "start b"]);
		children[0].finish("done");
		children[1].finish("done");
	});

	it("rejects an unstaggered launch whose signal is already aborted, starting nothing", async () => {
		const stop = new AbortController();
		stop.abort();
		const start = vi.fn(() => Promise.resolve("never"));
		await expect(staggeredLaunch("free|m", undefined, start, false)()(stop.signal)).rejects.toThrow(
			"Subagent cancelled",
		);
		expect(start).not.toHaveBeenCalled();
	});
});
