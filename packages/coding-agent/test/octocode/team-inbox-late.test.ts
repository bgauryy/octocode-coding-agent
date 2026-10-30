import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Inbox } from "../../src/octocode/team/inbox.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contacts/team";

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

describe("mail that arrives below the inbox watermark", () => {
	it("hands over only the forwarded older message, not the mail still in flight", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			for (const id of ["a-1", "b-1", "p-1"]) store.save(member(id));
			const older = store.send("a-1", ["p-1"], "older findings", { replyRequired: false }).id!;
			const inFlight = ["one", "two", "three"].map(
				(text) => store.send("a-1", ["b-1"], text, { replyRequired: false }).id!,
			);
			const inbox = new Inbox();
			const send = vi.fn((_batch: Message[]) => true);
			inbox.deliver(store, "b-1", send);
			expect(send.mock.calls[0][0].map((message) => message.id)).toEqual(inFlight);
			// Handed to Octocode, not yet seen by the model; then the parent forwards the older message.
			expect(store.refs.forward(older, "p-1", ["b-1"], { wake: false }).added).toEqual(["b-1"]);
			inbox.deliver(store, "b-1", send);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[1][0].map((message) => message.id)).toEqual([older]);
			// Nothing more on later ticks: each message was handed over once.
			inbox.deliver(store, "b-1", send);
			expect(send).toHaveBeenCalledTimes(2);
			inbox.seen(store, "b-1", [...inFlight, older]);
			inbox.deliver(store, "b-1", send);
			expect(send).toHaveBeenCalledTimes(2);
			expect(store.pending("b-1")).toEqual([]);
		} finally {
			store.close();
		}
	});
});
