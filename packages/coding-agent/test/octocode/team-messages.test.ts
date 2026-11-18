import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EXTERNAL_SENDER, USER_SENDER } from "../../src/octocode/shared/messages.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { userProof, userProofValid } from "../../src/octocode/team/proof.ts";
import { apiClientLabel, fencedParts, PARENT_FENCE_NOTE } from "../../src/octocode/shared/fence.ts";
import { messageText } from "../../src/octocode/team/routing.ts";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const message = (over: Partial<Message> = {}): Message => ({
	id: 7,
	from: "researcher-1234",
	to: "main-aaaaaa",
	text: "hi",
	at: 0,
	replyRequired: false,
	wake: false,
	...over,
});

describe("team message delivery", () => {
	it("counts the user's direct reply as the answer to a child's question", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			for (const id of ["child", "parent"])
				store.save({
					id,
					role: id,
					pid: process.pid,
					status: "idle",
					joinedAt: Date.now(),
					updatedAt: Date.now(),
					toolCalls: 0,
					input: 0,
					cacheRead: 0,
					output: 0,
					cost: 0,
					unpriced: false,
				});
			const ask = store.send("child", ["parent"], "Which one?", { replyRequired: true }).id!;
			expect(store.asks("child", "parent", 0)[0]?.answer).toBeUndefined();
			const reply = store.send("user", ["child"], "The second", { replyRequired: false, replyTo: ask }).id!;
			expect(store.asks("child", "parent", 0)[0]?.answer).toMatchObject({ id: reply, by: "user" });
		} finally {
			store.close();
		}
	});

	it("only completes and measures replies delivered to the original asker", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			for (const id of ["asker", "worker", "other"])
				store.save({
					id,
					role: id,
					pid: process.pid,
					status: "idle",
					joinedAt: Date.now(),
					updatedAt: Date.now(),
					toolCalls: 0,
					input: 0,
					cacheRead: 0,
					output: 0,
					cost: 0,
					unpriced: false,
				});
			const ask = store.send("asker", ["worker"], "Question", { replyRequired: true }).id!;
			store.ack("worker", [ask]);
			store.send("worker", ["other"], "Wrong recipient", { replyRequired: false, replyTo: ask });
			expect(store.recent().find((message) => message.id === ask)?.state).toBe("awaiting reply");
			expect(store.asks("asker", "worker", 0)[0]?.answer).toBeUndefined();
			expect(store.pending("asker")).toEqual([]);
			const reply = store.send("worker", ["asker", "other"], "Correct reply", {
				replyRequired: false,
				replyTo: ask,
			}).id;
			expect(store.recent().find((message) => message.id === ask)?.state).toBe("answered");
			expect(store.asks("asker", "worker", 0)[0]?.answer?.id).toBe(reply);
			expect(store.pending("asker")[0]?.wake).toBe(true);
		} finally {
			store.close();
		}
	});
	it("checks recipient liveness inside the transaction that stores the message", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			const member: Member = {
				id: "a-0001",
				role: "a",
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
			};
			store.save(member);
			const inTransaction: boolean[] = [];
			const internals = store as unknown as { db: DatabaseSync; reachable(): Set<string> };
			const reachable = internals.reachable.bind(store);
			internals.reachable = () => {
				inTransaction.push(internals.db.isTransaction);
				return reachable();
			};
			expect(store.send("main-aaaaaa", ["a-0001"], "hi", { replyRequired: false }).id).toBeGreaterThan(0);
			expect(inTransaction).toEqual([true]);
		} finally {
			store.close();
		}
	});

	it("stores the signature `sign` makes for each recipient with its delivery, and none where it cannot sign", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			for (const id of ["a-0001", "b-0002"])
				store.save({
					id,
					role: "a",
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
			const { id } = store.send("user", ["a-0001", "b-0002"], "hi", {
				replyRequired: false,
				sign: (message, recipient) =>
					recipient === "a-0001" ? userProof("secret-a", { id: message, to: recipient, text: "hi" }) : undefined,
			});
			const [mine] = store.pending("a-0001");
			expect(mine).toMatchObject({ id, to: "a-0001" });
			expect(userProofValid("secret-a", mine)).toBe(true);
			expect(store.pending("b-0002")[0].proof).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("keeps the short busy wait for background work across nested quick calls", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			const db = (store as unknown as { db: DatabaseSync }).db;
			const timeout = () => Number((db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>).timeout);
			const long = timeout();
			const seen = store.quick(() => {
				store.quick(() => undefined);
				return timeout();
			});
			expect(seen).toBeLessThan(long);
			expect(timeout()).toBe(long);
		} finally {
			store.close();
		}
	});

	it("keeps a message pending until the recipient acknowledges it (two-phase delivery)", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save({
				id: "a-0001",
				role: "a",
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
			const id = store.send("main-aaaaaa", ["a-0001"], "hi", { replyRequired: false }).id!;
			const later = store.send("main-aaaaaa", ["a-0001"], "later", { replyRequired: false }).id!;
			// Read but not acknowledged (not seen yet): still pending; `after` skips what was already handed over.
			expect(store.pending("a-0001").map((m) => m.id)).toEqual([id, later]);
			expect([store.waiting("a-0001", id), store.pending("a-0001", id).map((m) => m.id)]).toEqual([1, [later]]);
			store.ack("a-0001", [id, later]);
			expect(store.pending("a-0001")).toEqual([]);
			expect(store.recent()[0].state).toBe("delivered");
		} finally {
			store.close();
		}
	});

	it("stores a wake only for a question, an answer to the sender's open question, or a flagged sender", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			for (const id of ["a-0001", "b-0002"])
				store.save({
					id,
					role: "a",
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
			const wakeOf = (id: number) => store.pending("b-0002").find((entry) => entry.id === id)!.wake;
			expect(wakeOf(store.send("a-0001", ["b-0002"], "fyi", { replyRequired: false }).id!)).toBe(false);
			expect(wakeOf(store.send("a-0001", ["b-0002"], "question", { replyRequired: true }).id!)).toBe(true);
			expect(
				wakeOf(store.send(USER_SENDER, ["b-0002"], "from the user", { replyRequired: false, wake: true }).id!),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("names the message a reply answers in its header, for a peer and for the user, and not otherwise", () => {
		const peer = messageText(message({ replyTo: 5 }));
		const header = (text: string) => text.split("\n")[0];
		expect(header(peer)).toContain("researcher-1234");
		expect(header(peer)).toContain("#5");
		const user = messageText(message({ from: USER_SENDER, replyTo: 5 }), { fromUser: true });
		expect(header(user)).toContain("#5");
		expect(user.endsWith("\nhi")).toBe(true);
		expect(header(messageText(message()))).not.toContain("#5");
		const interrupted = messageText(message({ replyTo: 5, interrupt: true }), { stopped: true });
		expect(header(interrupted)).toContain("#5");
	});

	it("labels the sender, never passing an API client off as the user, and says how to reply", () => {
		const peer = messageText(message({ replyRequired: true }), { parentId: "main-aaaaaa" });
		expect(peer.split("\n")[0]).toContain("researcher-1234");
		expect(fencedParts(peer)).toEqual({
			body: "hi",
			footer: renderPrompt("notices/mail/reply-needed.md", { to: "researcher-1234", id: 7 }),
		});
		const fromParent = messageText(message({ from: "main-aaaaaa" }), { parentId: "main-aaaaaa" });
		expect(fromParent.split("\n")[0]).toContain("main-aaaaaa");
		expect(fromParent).toContain(PARENT_FENCE_NOTE);
		expect(peer).not.toContain(PARENT_FENCE_NOTE);
		expect(fencedParts(fromParent)?.footer).toBe(renderPrompt("notices/mail/no-reply-needed.md"));
		const user = messageText(message({ from: USER_SENDER }), { fromUser: true });
		expect(user).not.toContain("<<<untrusted-");
		expect(user.endsWith("\nhi")).toBe(true);
		// An API client is never the user: it is fenced under its own label and owes no reply even when it asks for one.
		const external = messageText(message({ from: EXTERNAL_SENDER, replyRequired: true }));
		expect(external).toContain(apiClientLabel());
		expect(fencedParts(external)).toEqual({ body: "hi", footer: "" });
	});

	it("tells a child its parent's message steers the task, and keeps every other sender untrusted data", () => {
		const note = (text: string) => /^<<<untrusted-[0-9a-f]{16} \((.*)\)$/m.exec(text)?.[1];
		const parent = messageText(message({ from: "main-aaaaaa" }), { parentId: "main-aaaaaa" });
		const senderNote = renderPrompt("notices/mail/fence-sender.md");
		expect(note(parent)).toBe(PARENT_FENCE_NOTE);
		expect(parent).not.toContain(senderNote);
		// The fence still parses, so renderers and footers keep working.
		expect(fencedParts(parent)).toMatchObject({
			body: "hi",
			footer: renderPrompt("notices/mail/no-reply-needed.md"),
		});
		for (const other of [
			messageText(message()),
			messageText(message({ from: "main-aaaaaa" }), { parentId: "someone-else" }),
			messageText(message({ from: "main-aaaaaa" })),
			messageText(message({ from: EXTERNAL_SENDER })),
			messageText(message({ from: USER_SENDER })),
		])
			expect(note(other)).toBe(senderNote);
	});
});
