import { expect, it, vi } from "vitest";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import { DeliveryReceipts } from "../../../src/octocode/wake/delivery-receipts.ts";

it("coalesces newer offsets while a database write waits and joins the final write at shutdown", async () => {
	const log = new MemoryEventStore();
	const first = Promise.withResolvers<void>();
	const last = Promise.withResolvers<void>();
	const commit = vi
		.spyOn(log, "commit")
		.mockImplementationOnce(() => first.promise)
		.mockImplementationOnce(() => last.promise);
	const receipts = new DeliveryReceipts(log, () => undefined, vi.fn());
	const writes = [receipts.commit(1), receipts.commit(2), receipts.commit(3)];
	expect(commit.mock.calls).toEqual([[1]]);
	let stopped = false;
	const stopping = receipts.settled().then(() => {
		stopped = true;
	});
	first.resolve();
	await first.promise;
	expect(commit.mock.calls).toEqual([[1], [3]]);
	expect(stopped).toBe(false);
	last.resolve();
	await Promise.all([...writes, stopping]);
	expect(stopped).toBe(true);
});

it("propagates a failed checkpoint and can retry the same offset", async () => {
	const log = new MemoryEventStore();
	const commit = vi.spyOn(log, "commit").mockImplementationOnce(() => Promise.reject(new Error("write failed")));
	const receipts = new DeliveryReceipts(log, () => undefined, vi.fn());
	await expect(receipts.commit(3)).rejects.toThrow("write failed");
	await receipts.commit(3);
	expect(commit.mock.calls).toEqual([[3], [3]]);
	expect(log.offset()).toBe(3);
});
