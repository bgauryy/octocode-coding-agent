import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { Inbox } from "../../src/octocode/team/inbox.ts";
import { Mail } from "../../src/octocode/team/mail.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { TeamTicker, type TeamView } from "../../src/octocode/team/ticker.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { INBOX_BATCH_SIZE } from "../../src/octocode/team/store/limits.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const member = (id: string): Member => ({
	id,
	role: "reviewer",
	pid: process.pid,
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("team delivery efficiency", () => {
	it("bounds whole-message handoff until context acknowledges it, with an interrupt escape lane", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save(member("recipient"));
			const ids = Array.from(
				{ length: 40 },
				(_, i) => store.send("sender", ["recipient"], `${i}:` + "界".repeat(7900), { replyRequired: false }).id!,
			);
			const inbox = new Inbox();
			const batches: Message[][] = [];
			const send = (batch: Message[]) => {
				batches.push(batch);
				return true;
			};
			for (let i = 0; i < 10; i++) inbox.deliver(store, "recipient", send);
			expect(batches).toHaveLength(1);
			expect(Buffer.byteLength(JSON.stringify(batches[0]))).toBeLessThanOrEqual(32 * 1024);
			const interrupt = store.send("sender", ["recipient"], "stop current work", {
				interrupt: true,
				replyRequired: false,
			}).id!;
			inbox.deliver(store, "recipient", send);
			expect(batches.at(-1)!.map((m) => m.id)).toEqual([interrupt]);
			for (let i = 0; i < 5; i++) inbox.deliver(store, "recipient", send);
			expect(batches).toHaveLength(2);
			inbox.seen(
				store,
				"recipient",
				batches.flat().map((m) => m.id),
			);
			while (store.waiting("recipient") > 0) {
				inbox.deliver(store, "recipient", send);
				inbox.seen(
					store,
					"recipient",
					batches.at(-1)!.map((m) => m.id),
				);
			}
			expect(
				batches
					.flat()
					.filter((m) => !m.interrupt)
					.map((m) => m.id),
			).toEqual(ids);
			expect(
				batches
					.flat()
					.filter((m) => !m.interrupt)
					.every((m) => m.text.endsWith("界".repeat(7900))),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("lets an idle wake pass unseen FYIs without draining their backlog", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save(member("recipient"));
			const inbox = new Inbox();
			const send = vi.fn((_batch: Message[]) => true);
			store.send("sender", ["recipient"], "FYI", { replyRequired: false });
			inbox.deliver(store, "recipient", send, true);
			const question = store.send("sender", ["recipient"], "please reply", { replyRequired: true }).id!;
			inbox.deliver(store, "recipient", send, true);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[1][0][0].id).toBe(question);
		} finally {
			store.close();
		}
	});

	it("batches every dead-letter notice and retries its database acknowledgement without sending it twice", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		const { api, sent } = fakeHost();
		const mail = new Mail(api);
		try {
			store.save(member("recipient"));
			const ids = Array.from(
				{ length: INBOX_BATCH_SIZE + 3 },
				(_, i) => store.send("sender", ["recipient"], `request ${i}`, { replyRequired: true }).id!,
			);
			store.remove("recipient");
			const mark = vi.spyOn(store, "markNotified").mockImplementationOnce(() => {
				throw new Error("busy");
			});
			expect(() => mail.reportDeadLetters(store, "sender")).not.toThrow();
			expect(sent).toHaveLength(1);
			mail.reportDeadLetters(store, "sender");
			mail.reportDeadLetters(store, "sender");
			expect(sent).toHaveLength(2);
			expect(mark).toHaveBeenCalledTimes(3);
			expect(store.deadLetters("sender")).toEqual([]);
			const notices = sent.map((entry) => String(entry.message.content)).join("\n");
			for (const id of ids) expect(notices.split(`Message #${id} to `)).toHaveLength(2);
			for (const entry of sent) expect(entry.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
		} finally {
			store.close();
		}
	});

	it("keeps all dead letters pending when Octocode refuses the notice batch", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		const { api, sent } = fakeHost();
		const mail = new Mail(api);
		try {
			store.save(member("recipient"));
			store.send("sender", ["recipient"], "request", { replyRequired: true });
			store.remove("recipient");
			vi.spyOn(api.session, "sendMessage").mockImplementationOnce(() => {
				throw new Error("not ready");
			});
			mail.reportDeadLetters(store, "sender");
			expect(store.deadLetters("sender")).toHaveLength(1);
			mail.reportDeadLetters(store, "sender");
			expect(sent).toHaveLength(1);
			expect(store.deadLetters("sender")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("forgets notice acknowledgements at a session reset without acknowledging colliding IDs in a new database", () => {
		const oldStore = TeamStore.open(tmp(), path.join(tmp(), "old.sqlite"));
		const newStore = TeamStore.open(tmp(), path.join(tmp(), "new.sqlite"));
		const { api, sent } = fakeHost();
		const mail = new Mail(api);
		try {
			for (const store of [oldStore, newStore]) {
				store.save(member("recipient"));
				store.send("sender", ["recipient"], store === oldStore ? "old session" : "new session", {
					replyRequired: true,
				});
				store.remove("recipient");
			}
			vi.spyOn(oldStore, "markNotified").mockImplementationOnce(() => {
				throw new Error("busy");
			});
			expect(() => mail.reportDeadLetters(oldStore, "sender")).not.toThrow();
			mail.reset();
			mail.reportDeadLetters(newStore, "sender");
			expect(sent).toHaveLength(2);
			expect(sent[1].message.content).toContain("new session");
			expect(newStore.deadLetters("sender")).toEqual([]);
			expect(oldStore.deadLetters("sender")).toHaveLength(1);
		} finally {
			oldStore.close();
			newStore.close();
		}
	});

	it("ignores an old notice handoff that settles after a new session starts", async () => {
		const oldStore = TeamStore.open(tmp(), path.join(tmp(), "old.sqlite"));
		const newStore = TeamStore.open(tmp(), path.join(tmp(), "new.sqlite"));
		const { api } = fakeHost();
		const mail = new Mail(api);
		let acceptOld!: () => void;
		const oldHandoff = new Promise<void>((resolve) => {
			acceptOld = resolve;
		});
		let acceptNew!: () => void;
		const newHandoff = new Promise<void>((resolve) => {
			acceptNew = resolve;
		});
		const send = vi.spyOn(api.session, "sendMessage").mockReturnValueOnce(oldHandoff).mockReturnValueOnce(newHandoff);
		try {
			for (const store of [oldStore, newStore]) {
				store.save(member("recipient"));
				store.send("sender", ["recipient"], store === oldStore ? "old" : "new", { replyRequired: true });
				store.remove("recipient");
			}
			mail.reportDeadLetters(oldStore, "sender");
			mail.reset();
			mail.reportDeadLetters(newStore, "sender");
			acceptOld();
			await oldHandoff;
			await Promise.resolve();
			expect(oldStore.deadLetters("sender")).toHaveLength(1);
			expect(newStore.deadLetters("sender")).toHaveLength(1);
			mail.reportDeadLetters(newStore, "sender");
			expect(send).toHaveBeenCalledTimes(2);
			acceptNew();
			await newHandoff;
			await Promise.resolve();
			expect(newStore.deadLetters("sender")).toEqual([]);
		} finally {
			oldStore.close();
			newStore.close();
		}
	});

	it("retries a busy notice acknowledgement after asynchronous host acceptance without resending", async () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		const { api } = fakeHost();
		const mail = new Mail(api);
		let accept!: () => void;
		const handoff = new Promise<void>((resolve) => {
			accept = resolve;
		});
		const send = vi.spyOn(api.session, "sendMessage").mockReturnValueOnce(handoff);
		try {
			store.save(member("recipient"));
			store.send("sender", ["recipient"], "request", { replyRequired: true });
			store.remove("recipient");
			vi.spyOn(store, "markNotified").mockImplementationOnce(() => {
				throw new Error("busy");
			});
			mail.reportDeadLetters(store, "sender");
			accept();
			await handoff;
			await Promise.resolve();
			expect(store.deadLetters("sender")).toHaveLength(1);
			mail.reportDeadLetters(store, "sender");
			expect(store.deadLetters("sender")).toEqual([]);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			store.close();
		}
	});

	it("does not rescan historical context or touch the database once handed mail is acknowledged", () => {
		vi.useFakeTimers();
		const cwd = tmp();
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const { api, sent } = fakeHost();
		const team = new Team(api, env);
		team.start(fakeCtx({ cwd }));
		const recipient = team.join().id;
		const store = TeamStore.open(cwd, env.OCTOCODE_AGENT_DB);
		try {
			store.send("sender", [recipient], "read me", { replyRequired: false });
			vi.advanceTimersByTime(1_000);
			const context = sent.map(({ message }) => ({
				role: "custom",
				customType: INTERNAL_MESSAGE_TYPE,
				details: message.details,
			}));
			team.onContext(context);
			expect(store.pending(recipient)).toEqual([]);
			const scan = vi.spyOn(context, "flatMap");
			const quick = vi.spyOn(TeamStore.prototype, "quick");
			for (let i = 0; i < 100; i++) team.onContext(context);
			expect(scan).not.toHaveBeenCalled();
			expect(quick).not.toHaveBeenCalled();
			store.send("sender", [recipient], "new mail", { replyRequired: false });
			vi.advanceTimersByTime(1_000);
			team.onContext(
				sent.map(({ message }) => ({
					role: "custom",
					customType: INTERNAL_MESSAGE_TYPE,
					details: message.details,
				})),
			);
			expect(store.pending(recipient)).toEqual([]);
		} finally {
			team.stop();
			store.close();
		}
	});

	it("runs no query while the database is unchanged since a read that found nothing waiting, and reads again after any write", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save(member("recipient"));
			const inbox = new Inbox();
			const send = vi.fn(() => true);
			const queries = [vi.spyOn(store, "waiting"), vi.spyOn(store, "waitingThrough"), vi.spyOn(store, "pending")];
			const asked = () => queries.reduce((total, spy) => total + spy.mock.calls.length, 0);
			inbox.deliver(store, "recipient", send);
			expect(asked()).toBe(1);
			for (let i = 0; i < 50; i++) inbox.deliver(store, "recipient", send);
			expect(asked()).toBe(1);
			expect(send).not.toHaveBeenCalled();
			// Another process writes mail: the stamp moves, the inbox reads, and hands it over.
			store.send("sender", ["recipient"], "new mail", { replyRequired: false });
			inbox.deliver(store, "recipient", send);
			expect(send).toHaveBeenCalledTimes(1);
			// A refused batch is offered again on the next tick, with the database unchanged.
			const refuse = vi.fn(() => false);
			const second = new Inbox();
			second.deliver(store, "recipient", refuse);
			second.deliver(store, "recipient", refuse);
			expect(refuse).toHaveBeenCalledTimes(2);
			// A reset forgets what it knew of the database.
			const before = asked();
			inbox.reset();
			inbox.deliver(store, "recipient", send);
			expect(asked()).toBeGreaterThan(before);
		} finally {
			store.close();
		}
	});

	it("tolerates a recipient departing between its waiting count and batch read", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save(member("recipient"));
			store.send("sender", ["recipient"], "request", { replyRequired: false });
			const pending = store.pending.bind(store);
			vi.spyOn(store, "pending").mockImplementation((id, after) => {
				store.remove(id);
				return pending(id, after);
			});
			const send = vi.fn(() => true);
			expect(() => new Inbox().deliver(store, "recipient", send)).not.toThrow();
			expect(send).not.toHaveBeenCalled();
			expect(store.deadLetters("sender")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});

describe("team view cache", () => {
	it("retries a transient failed snapshot even when the database stamp is unchanged", () => {
		vi.useFakeTimers();
		const file = path.join(tmp(), "team.sqlite");
		fs.writeFileSync(file, "unchanged");
		const read = vi
			.fn<() => TeamView>()
			.mockReturnValueOnce({ members: [], traffic: [], error: "busy", retrying: true })
			.mockReturnValue({ members: [], traffic: [] });
		const ticker = new TeamTicker({
			joined: () => false,
			beat: () => {},
			dbFile: () => file,
			read,
			maxAgeMs: 5_000,
			resumed: () => {},
		});
		const stop = ticker.watch(() => {});
		try {
			expect(ticker.view.retrying).toBe(true);
			vi.advanceTimersByTime(1_000);
			expect(read).toHaveBeenCalledTimes(2);
			expect(ticker.view.error).toBeUndefined();
			vi.advanceTimersByTime(20_000);
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			stop();
		}
	});

	it("expires recent traffic even when no members or database writes remain", () => {
		vi.useFakeTimers();
		const file = path.join(tmp(), "team.sqlite");
		fs.writeFileSync(file, "unchanged");
		const read = vi
			.fn<() => TeamView>()
			.mockReturnValueOnce({
				members: [],
				traffic: [{ id: 1, from: "sender", to: ["recipient"], text: "old", at: 1, state: "delivered" }],
			})
			.mockReturnValue({ members: [], traffic: [] });
		const ticker = new TeamTicker({
			joined: () => false,
			beat: () => {},
			dbFile: () => file,
			read,
			maxAgeMs: 5_000,
			resumed: () => {},
		});
		const stop = ticker.watch(() => {});
		try {
			vi.advanceTimersByTime(4_000);
			expect(read).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1_000);
			expect(read).toHaveBeenCalledTimes(2);
			expect(ticker.view.traffic).toEqual([]);
		} finally {
			stop();
		}
	});
});
