import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrefixStagger } from "../../src/octocode/subagents/stagger.ts";

/** A child that starts when launched and whose first reply starts when the test says so. */
function fakeChild(log: string[], name: string) {
	let warm: () => void = () => undefined;
	let finish: (outcome: string) => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	const done = new Promise<string>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	return {
		start: (w: () => void) => {
			log.push(`start ${name}`);
			warm = w;
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

	it("starts the first child at once and the siblings after its first reply starts", async () => {
		const stagger = new PrefixStagger();
		const log: string[] = [];
		const [a, b, c] = ["a", "b", "c"].map((name) => fakeChild(log, name));
		void stagger.run("researcher|m", undefined, a.start);
		void stagger.run("researcher|m", undefined, b.start);
		void stagger.run("researcher|m", undefined, c.start);
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

	it("cancels a waiting child on abort without starting it, leaving the others to go on", async () => {
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

	it("rejects at once for a signal that is already aborted", async () => {
		const stagger = new PrefixStagger();
		const stop = new AbortController();
		stop.abort();
		await expect(stagger.run("k", stop.signal, () => Promise.resolve("never"))).rejects.toThrow("Subagent cancelled");
	});
});
