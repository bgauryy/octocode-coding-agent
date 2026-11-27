import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Mail } from "../../src/octocode/team/mail.ts";
import { Relays } from "../../src/octocode/team/relay.ts";
import { deadLetterText, messageText } from "../../src/octocode/team/routing.ts";
import { readMessage, type ReferenceHost } from "../../src/octocode/team/session/references.ts";
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

/** A store with parent p-1 and its children a-1 and b-1, plus an unrelated agent x-1. */
function team(): TeamStore {
	const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
	for (const each of [member("p-1"), member("a-1", "p-1"), member("b-1", "p-1"), member("x-1")]) store.save(each);
	return store;
}

function host(store: TeamStore, me: string, extra: Partial<ReferenceHost> = {}): ReferenceHost {
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
		...extra,
	};
}

describe("message references (msg#N)", () => {
	it("forwards a stored message without copying it: original sender and id, forwarder and note shown", () => {
		const store = team();
		try {
			const { id } = store.send("a-1", ["p-1"], "the findings", { replyRequired: true });
			const result = store.refs.forward(id!, "p-1", ["b-1", "p-1", "gone-1"], { wake: true, note: "use this" });
			expect(result).toEqual({ added: ["b-1"], departed: ["gone-1"], already: ["p-1"] });
			expect(store.refs.forward(id!, "p-1", ["b-1"], { wake: true })).toMatchObject({ already: ["b-1"] });
			const [got] = store.pending("b-1");
			expect(got).toMatchObject({ id, from: "a-1", text: "the findings", forwardedBy: "p-1", note: "use this" });
			const text = messageText(got, { parentId: "p-1" });
			expect(text).toContain(`Message #${id} from agent a-1`);
			expect(text).toContain("(forwarded by p-1)");
			expect(text).toContain(`Note from p-1, who forwarded message #${id}`);
			// A reply goes to the original sender.
			expect(text).toContain(`(replyTo ${id})`);
			expect(store.recent()[0]).toMatchObject({ id, to: ["b-1", "p-1"] });
		} finally {
			store.close();
		}
	});

	it("reads a message only for its sender, a recipient, a forwarded recipient or the starter; others get not found", () => {
		const store = team();
		try {
			const { id } = store.send("a-1", ["b-1"], "secret plan", { replyRequired: false });
			for (const reader of ["a-1", "b-1", "p-1"])
				expect(readMessage(host(store, reader), id!, reader)).toMatchObject({ id, from: "a-1", text: "secret plan" });
			expect(readMessage(host(store, "x-1"), id!, "x-1")).toEqual({
				error: `no message #${id} that you can read in this repository (messages are kept 24 h)`,
			});
			expect(readMessage(host(store, "x-1"), 99_999, "x-1")).toEqual({
				error: "no message #99999 that you can read in this repository (messages are kept 24 h)",
			});
			store.refs.forward(id!, "b-1", ["x-1"], { wake: false });
			expect(readMessage(host(store, "x-1"), id!, "x-1")).toMatchObject({ forwardedBy: "b-1" });
			store.refs.retract(id!);
			// Expired reads like unreadable, so no reader learns that an id it may not read exists.
			expect(readMessage(host(store, "a-1"), id!, "a-1")).toEqual({
				error: `no message #${id} that you can read in this repository (messages are kept 24 h)`,
			});
		} finally {
			store.close();
		}
	});

	it("counts a run's unanswered questions to peers, not to its parent", () => {
		const store = team();
		try {
			store.send("a-1", ["p-1"], "parent question", { replyRequired: true });
			const { id } = store.send("a-1", ["b-1"], "peer question", { replyRequired: true });
			store.send("a-1", ["b-1"], "fyi", { replyRequired: false });
			expect(store.refs.unansweredPeerAsks("a-1", "p-1")).toBe(1);
			store.send("b-1", ["a-1"], "answer", { replyRequired: false, replyTo: id! });
			expect(store.refs.unansweredPeerAsks("a-1", "p-1")).toBe(0);
		} finally {
			store.close();
		}
	});
});

describe("a child's report answers the questions put to it", () => {
	const askAndRead = (store: TeamStore) => {
		const { id } = store.send("p-1", ["a-1"], "which file?", { replyRequired: true });
		store.ack("a-1", [id!]);
		return id!;
	};

	it("stops the parent being told its question went unanswered when the child left after reporting", () => {
		const store = team();
		try {
			askAndRead(store);
			store.refs.closeQuestionsTo("p-1", "a-1");
			store.remove("a-1");
			expect(store.deadLetters("p-1")).toEqual([]);
			expect(store.refs.openQuestions()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("settles a dead letter the parent was not yet told of, and leaves other questions alone", () => {
		const store = team();
		try {
			askAndRead(store);
			const other = store.send("p-1", ["b-1"], "and you?", { replyRequired: true }).id!;
			store.ack("b-1", [other]);
			store.remove("a-1");
			expect(store.deadLetters("p-1")).toHaveLength(1);
			store.refs.closeQuestionsTo("p-1", "a-1");
			expect(store.deadLetters("p-1")).toEqual([]);
			expect(store.refs.openQuestions()).toMatchObject([{ recipient: "b-1", id: other }]);
		} finally {
			store.close();
		}
	});

	it("holds the notice of a question the child read until its report is filed, so the report closes it first", () => {
		const store = team();
		const sent: string[] = [];
		const mail = new Mail({
			session: {
				sendMessage: (message: { content: unknown }) => {
					sent.push(String(message.content));
				},
			},
		});
		try {
			askAndRead(store);
			// The child left the team: its process is closing, and its report is not built yet.
			store.remove("a-1");
			let reporting = true;
			mail.reportDeadLetters(store, "p-1", (id) => reporting && id === "a-1");
			expect(sent).toEqual([]);
			// The report arrived: it answered the question.
			store.refs.closeQuestionsTo("p-1", "a-1");
			reporting = false;
			mail.reportDeadLetters(store, "p-1", (id) => reporting && id === "a-1");
			expect(sent).toEqual([]);
			expect(store.deadLetters("p-1")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("still reports a read question when the run ended without a report, and an unread message at once", () => {
		const store = team();
		const sent: string[] = [];
		const mail = new Mail({
			session: {
				sendMessage: (message: { content: unknown }) => {
					sent.push(String(message.content));
				},
			},
		});
		try {
			askAndRead(store);
			store.send("p-1", ["a-1"], "never read", { replyRequired: false });
			store.remove("a-1");
			mail.reportDeadLetters(store, "p-1", (id) => id === "a-1");
			expect(sent).toHaveLength(1);
			expect(sent[0]).toContain("a-1");
			mail.reportDeadLetters(store, "p-1", () => false);
			expect(sent).toHaveLength(2);
			// Read but unanswered is a different report than never read.
			expect(sent[1]).toContain("a-1");
			expect(sent[1]).not.toBe(sent[0]);
		} finally {
			store.close();
		}
	});

	it("without the close, the child's leaving reports the question read but not answered (the old behavior)", () => {
		const store = team();
		try {
			askAndRead(store);
			store.remove("a-1");
			expect(deadLetterText(store.deadLetters("p-1")[0])).toContain("a-1");
		} finally {
			store.close();
		}
	});
});

describe("B200 relay through the parent process", () => {
	it("stores a child's message to a finished sibling as a real row the parent's model never gets", async () => {
		const store = team();
		try {
			const result = await sendMessage(host(store, "a-1"), "done-1", "please re-check", { replyRequired: true });
			expect(result).toMatchObject({ sent: ["done-1"], relayed: "p-1" });
			const id = (result as { id: number }).id;
			expect(id).toBeGreaterThan(0);
			expect(store.pending("p-1")).toEqual([]);
			expect(store.waiting("p-1")).toBe(0);
			expect(store.refs.relays("p-1")).toMatchObject([{ target: "done-1", message: { id, from: "a-1" } }]);
			expect(store.refs.unansweredPeerAsks("a-1", "p-1")).toBe(1);
			// The relay row is addressed to the parent but asks the sibling: the report's "Asks to its coordinator" omits it.
			expect(store.asks("a-1", "p-1", 0)).toEqual([]);
			// A top-level session has no parent to relay through: the old refusal stays.
			expect(await sendMessage(host(store, "x-1"), "done-1", "hi")).toEqual({
				error: expect.stringContaining('No live agent "done-1"'),
			});
		} finally {
			store.close();
		}
	});

	it("resumes a lingering sibling with the stored message, without the parent's model", async () => {
		const store = team();
		try {
			const sent = await sendMessage(host(store, "a-1"), "done-1", "please re-check", { replyRequired: true });
			const id = (sent as { id: number }).id;
			const resumer = vi.fn<Resumer>(async () => "Resumed done-1");
			const relays = new Relays({
				id: () => "p-1",
				finished: new Map([["done-1", "x"]]),
				started: () => false,
				resumer: () => resumer,
			});
			relays.take(store);
			await vi.waitFor(() => expect(resumer).toHaveBeenCalled());
			const [to, , from, , request] = resumer.mock.calls[0];
			expect([to, from]).toEqual(["done-1", "p-1"]);
			expect(request?.message).toMatchObject({ id, from: "a-1", text: "please re-check" });
			expect(messageText(request!.message, { parentId: "p-1" })).toContain(`Message #${id} from agent a-1`);
			relays.take(store);
			expect(resumer).toHaveBeenCalledTimes(1);
			// The resumed sibling holds the delivery, so its answer (replyTo #id) reaches a-1 and completes it.
			expect(store.refs.read(id)).toMatchObject({ deliveries: [{ recipient: "done-1" }, { recipient: "p-1" }] });
			expect(store.deadLetters("a-1")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("dead-letters a relay to an agent that is neither live nor lingering, naming report:<id>", async () => {
		const store = team();
		try {
			await sendMessage(host(store, "a-1"), "done-1", "are you there?", { replyRequired: true });
			const relays = new Relays({
				id: () => "p-1",
				finished: new Map([["done-1", "x"]]),
				started: () => false,
				resumer: () => async () => undefined,
			});
			relays.take(store);
			await vi.waitFor(() => expect(store.deadLetters("a-1")).toHaveLength(1));
			const text = deadLetterText(store.deadLetters("a-1")[0]);
			expect(text).toContain("to done-1 was not delivered");
			expect(text).toContain("follow-up window has ended");
			expect(text).toContain("report:done-1");
			expect(store.refs.read(store.deadLetters("a-1")[0].id)).toMatchObject({
				deliveries: [{ recipient: "p-1" }],
			});
			// Unknown to the parent: also a dead letter, still naming the report reference.
			await sendMessage(host(store, "a-1"), "nobody-1", "hello");
			relays.take(store);
			await vi.waitFor(() => expect(store.deadLetters("a-1")).toHaveLength(2));
			expect(deadLetterText(store.deadLetters("a-1")[1])).toMatch(/cannot resume one by that name.*report:nobody-1/);
		} finally {
			store.close();
		}
	});

	it("stores a real row when the parent resumes its finished child, and removes it when the resume does not happen", async () => {
		const store = team();
		try {
			const resumer = vi.fn<Resumer>(async () => "Resumed done-1");
			const parent = host(store, "p-1", { finished: new Map([["done-1", "x"]]), resumer: () => resumer });
			const result = await sendMessage(parent, "done-1", "one more thing");
			expect(result).toMatchObject({ sent: ["done-1"], resumed: "Resumed done-1" });
			const id = (result as { id: number }).id;
			expect(id).toBeGreaterThan(0);
			expect(resumer.mock.calls[0][4]?.message).toMatchObject({ id, from: "p-1", text: "one more thing" });
			expect(store.refs.read(id)).toMatchObject({ from: "p-1", deliveries: [{ recipient: "done-1" }] });
			expect(store.waiting("done-1")).toBe(0);
			resumer.mockResolvedValueOnce(undefined);
			const refused = await sendMessage(parent, "done-1", "too late");
			expect(refused).toEqual({ error: expect.stringContaining("has finished and takes no more messages") });
			const lastId = resumer.mock.calls[1][4]?.message.id ?? 0;
			expect(store.refs.read(lastId)).toBe("expired");
		} finally {
			store.close();
		}
	});
});
