import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("session presentation subscribers", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("delivers the same event to remaining views when a view unsubscribes", async () => {
		harness = await createHarness();
		const { session } = harness;
		const seen: string[] = [];
		const unsubscribe = session.subscribe(() => {
			seen.push("first");
			unsubscribe();
		});
		session.subscribe(() => seen.push("second"));
		session.clearQueue();
		expect(seen).toEqual(["first", "second"]);
		session.clearQueue();
		expect(seen).toEqual(["first", "second", "second"]);
	});

	it("starts a newly mounted view on the next event", async () => {
		harness = await createHarness();
		const { session } = harness;
		const seen: string[] = [];
		const unsubscribe = session.subscribe(() => {
			seen.push("first");
			session.subscribe(() => seen.push("new"));
		});
		session.clearQueue();
		expect(seen).toEqual(["first"]);
		unsubscribe();
		session.clearQueue();
		expect(seen).toEqual(["first", "new"]);
	});
});
