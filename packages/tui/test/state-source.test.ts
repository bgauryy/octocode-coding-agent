import assert from "node:assert";
import { describe, it } from "node:test";
import { Connected, shallowEqual, type StateSource, watchSelection } from "../src/state-source.ts";

/** A minimal store with Zustand's shape: replace state, notify listeners. */
function store<S>(initial: S): StateSource<S> & { set(next: Partial<S>): void } {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			state = { ...state, ...next };
			for (const listener of listeners) listener();
		},
	};
}

describe("watchSelection", () => {
	it("reports only changes of the selection, with the previous value", () => {
		const source = store({ a: 1, b: 1 });
		const seen: Array<[number, number]> = [];
		const stop = watchSelection(
			source,
			(s) => s.a,
			(next, previous) => seen.push([next, previous]),
		);
		source.set({ b: 2 });
		source.set({ a: 1 });
		source.set({ a: 3 });
		stop();
		source.set({ a: 4 });
		assert.deepStrictEqual(seen, [[3, 1]]);
	});

	it("compares derived arrays shallowly when asked", () => {
		const source = store({ items: ["x"], other: 0 });
		let calls = 0;
		watchSelection(
			source,
			(s) => [...s.items],
			() => calls++,
			shallowEqual,
		);
		source.set({ other: 1 });
		assert.strictEqual(calls, 0);
		source.set({ items: ["x", "y"] });
		assert.strictEqual(calls, 1);
	});
});

describe("shallowEqual", () => {
	it("compares one level deep", () => {
		assert.ok(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" }));
		assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: undefined }));
		assert.ok(!shallowEqual({ a: { n: 1 } }, { a: { n: 1 } }));
		assert.ok(!shallowEqual([1], { 0: 1 }));
		assert.ok(shallowEqual(NaN, NaN));
	});
});

describe("Connected", () => {
	it("asks for a frame only when its selection changes, and caches lines per selection and width", () => {
		const source = store({ count: 1, unrelated: 0 });
		let frames = 0;
		let views = 0;
		const view = new Connected({
			source,
			select: (s) => s.count,
			view: (count, width) => {
				views++;
				return [`${count}@${width}`];
			},
			requestRender: () => frames++,
		});
		assert.deepStrictEqual(view.render(10), ["1@10"]);
		assert.strictEqual(view.render(10), view.render(10));
		source.set({ unrelated: 1 });
		assert.strictEqual(frames, 0);
		source.set({ count: 2 });
		assert.strictEqual(frames, 1);
		assert.deepStrictEqual(view.render(10), ["2@10"]);
		assert.deepStrictEqual(view.render(20), ["2@20"]);
		assert.strictEqual(views, 3);
		view.invalidate();
		view.render(20);
		assert.strictEqual(views, 4);
	});

	it("stops following the source after dispose and keeps its last lines", () => {
		const source = store({ count: 1 });
		let frames = 0;
		const view = new Connected({
			source,
			select: (s) => s.count,
			view: (count) => [String(count)],
			requestRender: () => frames++,
		});
		view.dispose();
		source.set({ count: 2 });
		assert.strictEqual(frames, 0);
		assert.deepStrictEqual(view.render(5), ["1"]);
	});
});
