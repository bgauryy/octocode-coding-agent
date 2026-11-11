import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../src/map-concurrent.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("mapConcurrent", () => {
	it("keeps input order when later items finish first", async () => {
		const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
		const result = mapConcurrent([0, 1, 2], 3, async (item) => {
			await gates[item].promise;
			return `item-${item}`;
		});
		gates[2].resolve();
		gates[1].resolve();
		gates[0].resolve();
		expect(await result).toEqual(["item-0", "item-1", "item-2"]);
	});

	it("never runs more than the limit at once", async () => {
		let running = 0;
		let peak = 0;
		const items = Array.from({ length: 10 }, (_, index) => index);
		const result = await mapConcurrent(items, 3, async (item) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running--;
			return item * 2;
		});
		expect(peak).toBe(3);
		expect(result).toEqual(items.map((item) => item * 2));
	});

	it("returns an empty list for no items and rejects with the first failure", async () => {
		expect(await mapConcurrent([], 3, async () => 1)).toEqual([]);
		await expect(
			mapConcurrent([1, 2], 2, async (item) => {
				if (item === 2) throw new Error("bad item");
				return item;
			}),
		).rejects.toThrow("bad item");
	});

	it("stops starting items once the signal aborts", async () => {
		const controller = new AbortController();
		const started: number[] = [];
		const result = mapConcurrent(
			[0, 1, 2, 3],
			1,
			async (item) => {
				started.push(item);
				if (item === 1) controller.abort();
				return item;
			},
			controller.signal,
		);
		await expect(result).rejects.toThrow();
		expect(started).toEqual([0, 1]);
	});
});
