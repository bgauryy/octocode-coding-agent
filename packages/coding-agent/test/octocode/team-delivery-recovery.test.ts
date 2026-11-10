import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Inbox } from "../../src/octocode/team/inbox.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { Relays } from "../../src/octocode/team/relay.ts";
import { deadLetterText, resolveTarget } from "../../src/octocode/team/routing.ts";
import type { ReferenceHost } from "../../src/octocode/team/session/references.ts";
import { type Resumer, sendMessage } from "../../src/octocode/team/session/send.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const member = (id: string, parentId?: string): Member => ({
	id,
	role: id.split("-")[0],
	...(parentId ? { parentId } : {}),
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

function team(): TeamStore {
	const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
	for (const each of [member("p-1"), member("a-1", "p-1")]) store.save(each);
	return store;
}

function child(store: TeamStore, me: string): ReferenceHost {
	const self = store.list().find((each) => each.id === me);
	return {
		me: () => self,
		ctx: () => undefined,
		db: () => store,
		store: () => store,
		parentId: () => self?.parentId,
		finished: new Map(),
		reporting: () => false,
		resumer: () => undefined,
		messageHook: () => undefined,
		signed: () => undefined,
		signedByParent: () => undefined,
		mail: { createdForUser: () => undefined },
		started: () => false,
	};
}

describe("a failed acknowledgement", () => {
	it("is recorded on a later tick even after the agent left", () => {
		const store = team();
		try {
			const id = store.send("p-1", ["a-1"], "hello", { replyRequired: false }).id!;
			const inbox = new Inbox();
			const send = vi.fn((_batch: Message[]) => true);
			inbox.deliver(store, "a-1", send);
			const ack = vi.spyOn(store, "ack").mockImplementation(() => {
				throw new Error("database is locked");
			});
			expect(() => inbox.seen(store, "a-1", [id])).toThrow("locked");
			inbox.reset(store, "a-1");
			ack.mockRestore();
			inbox.deliver(store, "a-1", send);
			expect(store.pending("a-1")).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("to: all", () => {
	it("reaches a stalled member of the session", () => {
		const members = [member("p-1"), member("a-1", "p-1")];
		const stalled = [member("b-1", "p-1")];
		const reached = resolveTarget(members, "p-1", "all", undefined, "p-1", stalled);
		expect(Array.isArray(reached) && reached.map((each) => each.id)).toEqual(["a-1", "b-1"]);
	});
});

describe("relay claims", () => {
	it("can be taken again once an unsettled claim's lease lapsed", async () => {
		const store = team();
		try {
			await sendMessage(child(store, "a-1"), "done-1", "question", { replyRequired: true });
			const [request] = store.refs.relays("p-1");
			const now = Date.now();
			expect(store.refs.takeRelay(request.message.id, "p-1", () => undefined, now)).toBe(true);
			expect(store.refs.relays("p-1", now + 1_000)).toEqual([]);
			expect(store.refs.takeRelay(request.message.id, "p-1", () => undefined, now + 1_000)).toBe(false);
			expect(store.refs.relays("p-1", now + 61_000)).toHaveLength(1);
			expect(store.refs.takeRelay(request.message.id, "p-1", () => undefined, now + 61_000)).toBe(true);
		} finally {
			store.close();
		}
	});

	it("tells the child of a failure whose first write was refused", async () => {
		const store = team();
		try {
			await sendMessage(child(store, "a-1"), "done-1", "question", { replyRequired: true });
			const resumer = vi.fn<Resumer>(async () => undefined as never);
			const relays = new Relays({
				id: () => "p-1",
				finished: new Map([["done-1", "x"]]),
				started: () => false,
				resumer: () => resumer,
			});
			const real = store.refs.failRelay.bind(store.refs);
			const fail = vi.spyOn(store.refs, "failRelay").mockImplementationOnce(() => {
				throw new Error("database is locked");
			});
			relays.take(store);
			await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
			expect(store.deadLetters("a-1")).toEqual([]);
			fail.mockImplementation(real);
			relays.take(store);
			expect(store.deadLetters("a-1").map(deadLetterText)).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
