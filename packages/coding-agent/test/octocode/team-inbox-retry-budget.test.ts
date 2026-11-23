import path from "node:path";
import { describe, expect, it } from "vitest";
import { Inbox } from "../../src/octocode/team/inbox.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const CAP = 32 * 1024;
const member = (id: string): Member => ({
	id,
	role: id.split("-")[0],
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

/** Mail that arrives below the watermark is handed over through the retry branch. */
function forwardedBelowWatermark(sizes: number[]) {
	const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
	for (const id of ["a-1", "b-1", "p-1"]) store.save(member(id));
	const older = sizes.map((size) => store.send("a-1", ["p-1"], "x".repeat(size), { replyRequired: false }).id!);
	store.send("a-1", ["b-1"], "in flight", { replyRequired: false });
	const inbox = new Inbox();
	const batches: Message[][] = [];
	const send = (batch: Message[]) => {
		batches.push(batch);
		return true;
	};
	inbox.deliver(store, "b-1", send);
	for (const id of older) store.refs.forward(id, "p-1", ["b-1"], { wake: false });
	return { store, inbox, batches, older, send };
}

describe("inbox retry batches", () => {
	it("keep to the byte budget and deliver every row once, in order", () => {
		const { store, inbox, batches, older, send } = forwardedBelowWatermark(Array(32).fill(2_000));
		try {
			for (let tick = 0; tick < 10; tick++) {
				inbox.deliver(store, "b-1", send);
				inbox.seen(
					store,
					"b-1",
					batches.flat().map((message) => message.id),
				);
			}
			const retries = batches.slice(1);
			expect(retries.length).toBeGreaterThan(1);
			for (const batch of retries) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(CAP);
			expect(retries.flat().map((message) => message.id)).toEqual(older);
		} finally {
			store.close();
		}
	});

	it("send one oversized message alone", () => {
		const { store, inbox, batches, older, send } = forwardedBelowWatermark([40_000, 100]);
		try {
			inbox.deliver(store, "b-1", send);
			inbox.deliver(store, "b-1", send);
			expect(batches.slice(1).map((batch) => batch.map((message) => message.id))).toEqual([[older[0]], [older[1]]]);
		} finally {
			store.close();
		}
	});
});
