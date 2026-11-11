import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrefixStagger, type StaggerTurn } from "../../src/octocode/subagents/stagger.ts";

/**
 * A child whose process starts when launched (`spawned`), whose first request goes out once its turn is ready
 * (`log`: "start <name>"), and whose first reply starts when the test says so.
 */
function fakeChild(log: string[], name: string, spawned: string[] = []) {
	let warm: () => void = () => undefined;
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
			turn.ready().then(() => log.push(`start ${name}`), fail);
			return done;
		},
		reply: () => warm(),
		finish,
		fail,
	};
}

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

	it("does not hold siblings past the bound when the first child never replies", async () => {
		const stagger = new PrefixStagger(10_000);
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("k", undefined, a.start);
		void stagger.run("k", undefined, b.start);
		void stagger.run("k", undefined, c.start);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(log).toEqual(["start a"]);
		await vi.advanceTimersByTimeAsync(1);
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
		const stagger = new PrefixStagger(10_000, 60_000);
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
});
