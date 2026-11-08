import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXTERNAL_SENDER, INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { Delivery } from "../../src/octocode/team/delivery.ts";
import type { Mail } from "../../src/octocode/team/mail.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { WAKE_INTERVAL_MS, WAKE_WINDOW_MS, WAKES_PER_WINDOW, WakePace } from "../../src/octocode/team/wake-pace.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

describe("WakePace", () => {
	it("allows a first wake, then waits out the interval", () => {
		let now = 5_000;
		const pace = new WakePace(() => now);
		expect(pace.allows()).toBe(true);
		pace.record();
		now += WAKE_INTERVAL_MS - 1;
		expect(pace.allows()).toBe(false);
		now += 1;
		expect(pace.allows()).toBe(true);
	});

	it("caps the wakes in a window and recovers as the oldest ones age out", () => {
		let now = 0;
		const pace = new WakePace(() => now);
		for (let wake = 0; wake < WAKES_PER_WINDOW; wake++) {
			expect(pace.allows()).toBe(true);
			pace.record();
			now += WAKE_INTERVAL_MS;
		}
		// The interval has passed since the last wake, but the window is spent.
		expect(pace.allows()).toBe(false);
		now = WAKE_WINDOW_MS - 1;
		expect(pace.allows()).toBe(false);
		now = WAKE_WINDOW_MS;
		expect(pace.allows()).toBe(true);
		pace.record();
		// The second-oldest wake leaves the window next: one slot at a time.
		now = WAKE_WINDOW_MS + 1;
		expect(pace.allows()).toBe(false);
		now = WAKE_WINDOW_MS + WAKE_INTERVAL_MS;
		expect(pace.allows()).toBe(true);
	});

	it("forgets everything on reset, and ignores wakes dated after a clock set back", () => {
		let now = 100_000;
		const pace = new WakePace(() => now);
		pace.record();
		pace.reset();
		expect(pace.allows()).toBe(true);
		pace.record();
		now = 1_000;
		expect(pace.allows()).toBe(true);
	});
});

const row = (id: string): Member => ({
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

/** A recipient's `Delivery` over a real database, a scripted clock and a mail that records what it was handed. */
function recipient() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const store = TeamStore.open(cwd, path.join(tmp(), "team.sqlite"));
	for (const id of ["me", "peer", "other", "user"]) store.save(row(id));
	const clock = { now: 1_000_000 };
	const state = { idle: true };
	const handed: Message[][] = [];
	const rejectors: Array<() => void> = [];
	const mail = {
		settled: () => false,
		notice: () => true,
		forgetForUser: () => undefined,
		modelCalled: () => undefined,
		reportDeadLetters: () => undefined,
		deliver: (batch: Message[], _parent: unknown, _ctx: unknown, onRejected?: () => void) => {
			handed.push(batch);
			if (onRejected) rejectors.push(onRejected);
			return true;
		},
	} as unknown as Mail;
	const delivery = new Delivery(
		{
			id: () => "me",
			parentId: () => undefined,
			ctx: () => ({ isIdle: () => state.idle, hasUI: false }) as never,
			headless: () => false,
			heartbeat: () => false,
			relays: () => undefined,
			reporting: () => false,
			checkIn: () => ({ seconds: 0, parentWaits: false }),
		},
		mail,
		new WakePace(() => clock.now),
	);
	return {
		store,
		clock,
		state,
		handed,
		/** Octocode refuses the latest handoff after accepting the call. */
		reject: () => rejectors.at(-1)!(),
		tick: () => delivery.deliver(store),
		/** The model was called with everything handed over so far. */
		read: () =>
			delivery.seen(store, [
				{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: { messages: handed.flat() } },
			]),
		texts: () => handed.map((batch) => batch.map((message) => message.text)),
	};
}

let open: ReturnType<typeof recipient> | undefined;
const agent = () => (open = recipient());
afterEach(() => open?.store.close());

const wake = { replyRequired: false, wake: true } as const;

describe("an idle agent's peer-started turns", () => {
	it("start one turn per interval, and held mail joins the next one exactly once", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		expect(me.texts()).toEqual([["first"]]);
		me.read();

		me.clock.now += 10_000;
		me.store.send("peer", ["me"], "second", wake);
		me.tick();
		me.clock.now += 10_000;
		me.store.send("other", ["me"], "third (an FYI)", { replyRequired: false });
		me.store.send("other", ["me"], "fourth", wake);
		me.tick();
		me.tick();
		expect(me.texts()).toEqual([["first"]]);

		me.clock.now += 10_000;
		me.tick();
		expect(me.texts()).toEqual([["first"], ["second", "third (an FYI)", "fourth"]]);
		me.read();
		me.tick();
		me.tick();
		expect(me.handed).toHaveLength(2);

		// That turn counted: the next peer wake waits for a full interval after it.
		me.store.send("peer", ["me"], "fifth", wake);
		me.tick();
		expect(me.handed).toHaveLength(2);
		me.clock.now += WAKE_INTERVAL_MS;
		me.tick();
		expect(me.texts().at(-1)).toEqual(["fifth"]);
	});

	it("holds a peer wake that arrives before the earlier mail was read, and hands it later", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.store.send("peer", ["me"], "second", wake);
		me.tick();
		expect(me.texts()).toEqual([["first"]]);
		me.clock.now += WAKE_INTERVAL_MS;
		me.tick();
		expect(me.texts()).toEqual([["first"], ["second"]]);
	});

	it("never holds the user's message, and the held peer mail goes with it", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.store.send("peer", ["me"], "held", wake);
		me.tick();
		expect(me.handed).toHaveLength(1);
		me.store.send("user", ["me"], "from the user", { replyRequired: false, wake: true });
		me.tick();
		expect(me.texts()).toEqual([["first"], ["held", "from the user"]]);
	});

	// One admission of `agents.tell` to "all" reaches every idle agent in the session tree: each paces it as a peer's wake.
	it("holds an API client's broadcast like a peer's wake, and hands it once the interval passed", () => {
		const me = agent();
		me.store.save(row(EXTERNAL_SENDER));
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.store.send(EXTERNAL_SENDER, ["me", "other"], "everyone: status?", wake);
		me.tick();
		expect(me.handed).toHaveLength(1);
		me.clock.now += WAKE_INTERVAL_MS;
		me.tick();
		expect(me.texts()).toEqual([["first"], ["everyone: status?"]]);
	});

	it("never holds an API client's message to this agent alone, and the held broadcast goes with it", () => {
		const me = agent();
		me.store.save(row(EXTERNAL_SENDER));
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.store.send(EXTERNAL_SENDER, ["me", "other"], "everyone: status?", wake);
		me.tick();
		expect(me.handed).toHaveLength(1);
		me.store.send(EXTERNAL_SENDER, ["me"], "you alone", wake);
		me.tick();
		expect(me.texts()).toEqual([["first"], ["everyone: status?", "you alone"]]);
	});

	it("never holds an interrupt", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.store.send("peer", ["me"], "stop that", { replyRequired: false, interrupt: true });
		me.tick();
		expect(me.texts()).toEqual([["first"], ["stop that"]]);
	});

	it("never holds the answer to a question it asked, but holds a reply to its FYI", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		const question = me.store.send("me", ["peer"], "which file?", { replyRequired: true }).id!;
		const note = me.store.send("me", ["other"], "fyi", { replyRequired: false }).id!;
		me.store.ack("peer", [question]);
		me.store.ack("other", [note]);
		// A reply to the FYI with `wake` is a peer's choice: paced.
		me.store.send("other", ["me"], "thanks, noted", { ...wake, replyTo: note });
		me.tick();
		expect(me.handed).toHaveLength(1);
		// The answer to the open question comes through at once, with the held reply.
		me.store.send("peer", ["me"], "src/x.ts", { replyRequired: false, replyTo: question });
		me.tick();
		expect(me.texts()).toEqual([["first"], ["thanks, noted", "src/x.ts"]]);
	});

	it("does not hold mail for a busy agent, and a busy handoff does not use up the pace", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.state.idle = false;
		me.store.send("peer", ["me"], "while busy", wake);
		me.tick();
		expect(me.texts()).toEqual([["first"], ["while busy"]]);
		me.read();
		// Idle again, past the interval since the only counted wake: a new one starts a turn at once.
		me.state.idle = true;
		me.clock.now += WAKE_INTERVAL_MS;
		me.store.send("peer", ["me"], "after", wake);
		me.tick();
		expect(me.texts().at(-1)).toEqual(["after"]);
	});

	it("does not count a turn Octocode refused to start, so its retry is not held", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		expect(me.handed).toHaveLength(1);
		me.reject();
		me.tick();
		expect(me.texts()).toEqual([["first"], ["first"]]);
	});

	it("holds nothing that does not wake it", () => {
		const me = agent();
		me.store.send("peer", ["me"], "first", wake);
		me.tick();
		me.read();
		me.store.send("peer", ["me"], "quiet FYI", { replyRequired: false });
		me.tick();
		expect(me.texts()).toEqual([["first"], ["quiet FYI"]]);
	});
});
