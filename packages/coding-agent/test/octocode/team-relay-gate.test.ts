import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Relays } from "../../src/octocode/team/relay.ts";
import { deadLetterText } from "../../src/octocode/team/routing.ts";
import type { ReferenceHost } from "../../src/octocode/team/session/references.ts";
import { type Resumer, sendMessage } from "../../src/octocode/team/session/send.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contacts/team";

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

/** Parent p-1 with child a-1; done-1 is a finished child of p-1 that lingers. */
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
		resumer: () => undefined,
		messageHook: () => undefined,
		signed: () => undefined,
		mail: { createdForUser: () => undefined },
		started: () => false,
	};
}

function parent(resumer: Resumer, started: (id: string) => boolean = () => false): Relays {
	return new Relays({ id: () => "p-1", finished: new Map([["done-1", "x"]]), started, resumer: () => resumer });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("relay resumes only for questions and their answers", () => {
	it("dead-letters an FYI to a finished sibling instead of resuming it, naming report:<id>", async () => {
		const store = team();
		try {
			await sendMessage(child(store, "a-1"), "done-1", "thanks");
			const resumer = vi.fn<Resumer>(async () => "Resumed");
			parent(resumer).take(store);
			await settle();
			expect(resumer).not.toHaveBeenCalled();
			const [letter] = store.deadLetters("a-1");
			expect(deadLetterText(letter)).toMatch(/asks no question does not resume.*report:done-1/);
		} finally {
			store.close();
		}
	});

	it("resumes for the answer to the target's own question, not for a reply to its FYI", async () => {
		const store = team();
		try {
			const ask = store.send("done-1", ["a-1"], "which file?", { replyRequired: true }).id!;
			const fyi = store.send("done-1", ["a-1"], "done, thanks", { replyRequired: false }).id!;
			const resumer = vi.fn<Resumer>(async () => "Resumed");
			const relays = parent(resumer);
			await sendMessage(child(store, "a-1"), "done-1", "you're welcome", { replyTo: fyi });
			relays.take(store);
			await settle();
			expect(resumer).not.toHaveBeenCalled();
			await sendMessage(child(store, "a-1"), "done-1", "src/a.ts", { replyTo: ask });
			relays.take(store);
			await vi.waitFor(() => expect(resumer).toHaveBeenCalledTimes(1));
			expect(resumer.mock.calls[0][4]?.message).toMatchObject({ text: "src/a.ts", replyTo: ask });
		} finally {
			store.close();
		}
	});

	it("bounds resumes of one target even when every hop asks a question: no ping-pong", async () => {
		const store = team();
		try {
			const resumer = vi.fn<Resumer>(async () => "Resumed");
			const relays = parent(resumer);
			const start = Date.now();
			for (let hop = 0; hop < 5; hop++) {
				await sendMessage(child(store, "a-1"), "done-1", `question ${hop}`, { replyRequired: true });
				// Each hop after the previous resume's rejoin wait, inside one budget window.
				relays.take(store, start + hop * 61_000 + 120_000);
				await settle();
			}
			expect(resumer).toHaveBeenCalledTimes(3);
			const letters = store.deadLetters("a-1").map(deadLetterText);
			expect(letters).toHaveLength(2);
			expect(letters[0]).toMatch(/already resumed 3 times by relay.*report:done-1/);
		} finally {
			store.close();
		}
	});
});

describe("relay settlement", () => {
	it("keeps a second request for a target whose resume is pending, then delivers it to the target's inbox", async () => {
		const store = team();
		try {
			let finish: (value: string) => void = () => undefined;
			const resumer = vi.fn<Resumer>(() => new Promise<string>((resolve) => (finish = resolve)));
			const relays = parent(resumer);
			await sendMessage(child(store, "a-1"), "done-1", "here is X, check it", { replyRequired: true });
			const second = await sendMessage(child(store, "a-1"), "done-1", "also Y");
			relays.take(store);
			relays.take(store);
			expect(resumer).toHaveBeenCalledTimes(1);
			finish("Resumed");
			await settle();
			store.save(member("done-1", "p-1"));
			relays.take(store);
			expect(resumer).toHaveBeenCalledTimes(1);
			expect(store.pending("done-1").map((message) => message.id)).toEqual([(second as { id: number }).id]);
			expect(store.deadLetters("a-1")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("relays a question from a child that exited before the parent's tick", async () => {
		const store = team();
		try {
			await sendMessage(child(store, "a-1"), "done-1", "last question", { replyRequired: true });
			store.remove("a-1");
			const resumer = vi.fn<Resumer>(async () => "Resumed");
			parent(resumer, (id) => id === "a-1").take(store);
			await vi.waitFor(() => expect(resumer).toHaveBeenCalledTimes(1));
			// A sender this agent never started is still refused.
			store.save(member("x-1"));
			store.refs.relay("x-1", "p-1", "done-1", "from outside", { replyRequired: true });
			parent(resumer).take(store);
			await settle();
			expect(resumer).toHaveBeenCalledTimes(1);
			expect(deadLetterText(store.deadLetters("x-1")[0])).toContain("relays only messages from agents it started");
		} finally {
			store.close();
		}
	});

	it("dead-letters a relay its parent took but never settled when the parent leaves", async () => {
		const store = team();
		try {
			const sent = await sendMessage(child(store, "a-1"), "done-1", "fyi");
			const id = (sent as { id: number }).id;
			expect(store.refs.claimRelay(id, "p-1")).toBe(true);
			store.remove("p-1");
			const [letter] = store.deadLetters("a-1");
			expect(letter).toMatchObject({ id, relay: { to: "done-1" } });
			expect(deadLetterText(letter)).toContain("which relays it, left the team first");
		} finally {
			store.close();
		}
	});
});
