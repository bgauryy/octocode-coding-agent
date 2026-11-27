import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Delivery } from "../../src/octocode/team/delivery.ts";
import type { Mail } from "../../src/octocode/team/mail.ts";
import type { ReferenceHost } from "../../src/octocode/team/session/references.ts";
import { sendMessage } from "../../src/octocode/team/session/send.ts";
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

const stores: TeamStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function team(ids: Array<[string, string?]>): TeamStore {
	const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
	stores.push(store);
	for (const [id, parent] of ids) store.save(member(id, parent));
	return store;
}

function host(store: TeamStore, me: string, starting?: () => string[]): ReferenceHost {
	const self = store.list().find((each) => each.id === me);
	return {
		me: () => self,
		ctx: () => undefined,
		db: () => store,
		store: () => store,
		parentId: () => self?.parentId,
		finished: new Map(),
		reporting: () => false,
		...(starting ? { starting } : {}),
		resumer: () => undefined,
		messageHook: () => undefined,
		signed: () => undefined,
		signedByParent: () => undefined,
		mail: { createdForUser: () => undefined },
		started: () => false,
	};
}

describe("a broadcast and the children still starting", () => {
	it("names a child that has not joined yet as not reached, and still reaches the joined ones", async () => {
		const store = team([["p-1"], ["a-1", "p-1"]]);
		// s-1 is named by `agent` and running, but has no member row yet; a-1 joined.
		const result = await sendMessage(
			host(store, "p-1", () => ["a-1", "s-1"]),
			"all",
			"stand-up",
		);
		expect(result).toMatchObject({ sent: ["a-1"], starting: ["s-1"] });
	});

	it("says nothing about starting children when none are pending, or for a named recipient", async () => {
		const store = team([["p-1"], ["a-1", "p-1"]]);
		const none = await sendMessage(
			host(store, "p-1", () => ["a-1"]),
			"all",
			"stand-up",
		);
		expect(none).not.toHaveProperty("starting");
		const named = await sendMessage(
			host(store, "p-1", () => ["s-1"]),
			"a-1",
			"hello",
		);
		expect(named).not.toHaveProperty("starting");
	});

	it("refuses with the names when only starting children exist, so nothing is lost silently", async () => {
		const store = team([["p-1"]]);
		const result = await sendMessage(
			host(store, "p-1", () => ["s-1"]),
			"all",
			"stand-up",
		);
		expect(result).toMatchObject({ error: expect.stringMatching(/Still starting, so not reached: s-1/) });
	});
});

describe("an idle headless subagent and its children's relay requests", () => {
	function delivery(store: TeamStore, relays: () => void): Delivery {
		const mail = {
			settled: () => false,
			notice: () => true,
			forgetForUser: () => undefined,
			reportDeadLetters: () => undefined,
			deliver: () => true,
			pruneForUser: () => undefined,
		} as unknown as Mail;
		return new Delivery(
			{
				id: () => "k-1",
				parentId: () => "p-1",
				ctx: () => ({ isIdle: () => true, hasUI: false }) as never,
				headless: () => true,
				heartbeat: () => false,
				relays,
				reporting: () => false,
				checkIn: () => ({ seconds: 0, parentWaits: false }),
			},
			mail,
		);
	}

	it("still settles relays on a tick, while its own mail keeps waiting", () => {
		const store = team([["p-1"], ["k-1", "p-1"]]);
		const relays = vi.fn();
		delivery(store, relays).deliver(store);
		expect(relays).toHaveBeenCalledTimes(1);
	});
});
