import { describe, expect, it } from "vitest";
import { ApplicationCollection } from "../src/core/application/collection.ts";
import { PersistentMap } from "@octocodeai/octocode-common/persistent-map";
import { createApplicationState } from "../src/core/application/state.ts";
import type { ApplicationMessage } from "@octocodeai/octocode-contracts";

function random(seed: number): (below: number) => number {
	let state = seed >>> 0;
	return (below) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		// The high bits: an LCG's low bits repeat with short periods.
		return Math.floor((state / 2 ** 32) * below);
	};
}

const entriesOf = <T>(map: ReadonlyMap<string, T>) => [...map];

describe("PersistentMap", () => {
	it("seeks values by insertion index across trie boundaries without changing older versions", () => {
		const model = new Map<string, number>(Array.from({ length: 2000 }, (_, index) => [`k${index}`, index] as const));
		const stored = PersistentMap.from(model);
		const next = stored.set("k1999", -1).set("new", 2000);
		for (const start of [-10, 0, 1, 31, 32, 33, 1023, 1024, 1025, 1999, 2000, 3000]) {
			expect([...stored.valuesFrom(start)]).toEqual([...model.values()].slice(Math.max(0, start)));
			expect([...next.valuesFrom(start)]).toEqual(
				[...new Map(model).set("k1999", -1).set("new", 2000).values()].slice(Math.max(0, start)),
			);
		}
	});

	for (const seed of [3, 11, 2026]) {
		it(`matches Map on random sets, and every kept version stays as it was (seed ${seed})`, () => {
			const pick = random(seed);
			// Versions with the Map that mirrors each: sets go to the newest or, now and then, to an older one (a fork).
			const versions: Array<{ map: PersistentMap<number>; model: Map<string, number> }> = [
				{ map: PersistentMap.empty(), model: new Map() },
			];
			let tip = versions[0];
			const same = (version: (typeof versions)[number]) => {
				expect(version.map.size).toBe(version.model.size);
				expect(JSON.stringify(entriesOf(version.map))).toBe(JSON.stringify(entriesOf(version.model)));
			};
			// Past 1,024 keys, so the trie gains a level while older versions are still held.
			for (let step = 0; step < 4000; step++) {
				const fork = pick(10) === 0;
				const from = fork ? versions[pick(versions.length)] : tip;
				const key = from.model.size > 0 && pick(2) === 0 ? [...from.model.keys()][pick(from.model.size)] : `k${step}`;
				const map = from.map.set(key, step);
				const model = new Map(from.model).set(key, step);
				versions.push({ map, model });
				if (!fork) tip = versions[versions.length - 1];
				if (step % 100 === 0) for (let check = 0; check < 20; check++) same(versions[pick(versions.length)]);
				expect(map.get(key)).toBe(step);
				expect(map.has(`k${step + 1}`)).toBe(false);
			}
			for (let check = 0; check < 200; check++) same(versions[pick(versions.length)]);
			const last = tip;
			same(last);
			expect(last.map.size).toBeGreaterThan(1024);
			expect([...last.map.keys()]).toEqual([...last.model.keys()]);
			expect([...last.map.values()]).toEqual([...last.model.values()]);
			const visited: string[] = [];
			last.map.forEach((value, key) => {
				visited.push(key);
				expect(last.model.get(key)).toBe(value);
			});
			expect(visited).toEqual([...last.model.keys()]);
		});
	}

	it("takes over a plain map in its order, and copies no node another version holds inside a batch", () => {
		const plain = new Map(Array.from({ length: 2000 }, (_, index) => [`m${index}`, index] as const));
		const kept = PersistentMap.from(plain);
		expect(entriesOf(kept)).toEqual(entriesOf(plain));
		const owned = new Set<unknown[]>();
		let draft = kept;
		for (let index = 0; index < 2000; index++) draft = draft.set(`m${index}`, -index, owned);
		draft = draft.set("new", 1, owned);
		expect(entriesOf(kept)).toEqual(entriesOf(plain));
		expect(draft.get("m1999")).toBe(-1999);
		expect(draft.size).toBe(2001);
	});
});

describe("ApplicationCollection", () => {
	const message = (id: string, text: string) => ({ id, text }) as unknown as ApplicationMessage;

	it("publishes every change as a new version, in order, and leaves earlier versions unchanged", () => {
		const state = createApplicationState();
		const collection = new ApplicationCollection(
			() => state.getState().messages,
			(messages) => state.setState({ messages }),
		);
		const published: Array<ReadonlyMap<string, ApplicationMessage>> = [];
		state.subscribe((next, previous) => {
			if (next.messages !== previous.messages) published.push(next.messages);
		});
		const pick = random(5);
		const model = new Map<string, ApplicationMessage>();
		const expected: Array<Array<[string, ApplicationMessage]>> = [];
		for (let step = 0; step < 500; step++) {
			const id = model.size && pick(3) ? [...model.keys()][pick(model.size)] : `m${step}`;
			const value = message(id, `text ${step}`);
			if (pick(20) === 0) {
				// A batch publishes once, at its end.
				collection.batch(() => {
					collection.set(id, value);
					collection.set(`b${step}`, message(`b${step}`, "batched"));
					expect(collection.values.get(id)).toBe(value);
				});
				model.set(id, value).set(`b${step}`, message(`b${step}`, "batched"));
			} else {
				collection.set(id, value);
				model.set(id, value);
			}
			expected.push(entriesOf(model));
		}
		expect(published.length).toBe(expected.length);
		published.forEach((version, index) => expect(entriesOf(version)).toEqual(expected[index]));
		const last = published[published.length - 1];
		collection.clear();
		expect(state.getState().messages.size).toBe(0);
		expect(entriesOf(last)).toEqual(expected[expected.length - 1]);
	});

	it("extends a map a store reset left behind", () => {
		const state = createApplicationState();
		const collection = new ApplicationCollection(
			() => state.getState().messages,
			(messages) => state.setState({ messages }),
		);
		collection.set("a", message("a", "1"));
		state.setState({ messages: new Map([["x", message("x", "reset")]]) });
		collection.set("b", message("b", "2"));
		expect([...state.getState().messages.keys()]).toEqual(["x", "b"]);
	});
});
