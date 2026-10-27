import { describe, expect, it } from "vitest";
import { createApplicationState, reserveReceipt } from "../src/core/application/state.ts";

function fill(count: number, status: "accepted" | "completed" | "failed" = "completed") {
	const store = createApplicationState("s");
	const receipts = new Map();
	for (let index = 0; index < count; index++)
		receipts.set(`id-${index}`, { fingerprint: "f", receipt: { id: `id-${index}`, status } });
	store.setState({ receipts });
	return store;
}

describe("command receipt capacity", () => {
	it("accepts commands below the limit without touching receipts", () => {
		const store = fill(999);
		const before = store.getState().receipts;
		reserveReceipt(store);
		expect(store.getState().receipts).toBe(before);
	});

	it("evicts the oldest settled receipts at the limit instead of failing", () => {
		const store = fill(1000);
		reserveReceipt(store);
		const ids = [...store.getState().receipts.keys()];
		expect(ids).toHaveLength(500);
		expect(ids[0]).toBe("id-500");
		expect(ids.at(-1)).toBe("id-999");
	});

	it("keeps receipts of commands still running", () => {
		const store = fill(1000);
		const receipts = new Map(store.getState().receipts);
		receipts.set("id-0", { fingerprint: "f", receipt: { id: "id-0", status: "accepted" } });
		store.setState({ receipts });
		reserveReceipt(store);
		expect(store.getState().receipts.has("id-0")).toBe(true);
	});

	it("still refuses when every receipt is for a running command", () => {
		const store = fill(1000, "accepted");
		expect(() => reserveReceipt(store)).toThrow("Command receipt capacity reached");
	});
});
