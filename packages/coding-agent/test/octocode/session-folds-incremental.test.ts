import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import type { CatalogEntry } from "../../../db/src/api.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { recordSession } from "../../src/octocode/sessions/catalog.ts";
import type { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { EntryCursor } from "../../src/octocode/shared/entry-cursor.ts";
import { SpendScan } from "../../src/octocode/shared/spend.ts";
import {
	headerInContext,
	injectedIds,
	MEMORY_HEADER,
	MEMORY_HEADER_AGAIN,
	MEMORY_MESSAGE_TYPE,
	sessionInjections,
} from "../../src/octocode/memory/inject.ts";
import { tmp } from "./helpers.ts";

/** A small seeded generator, so a failing sequence replays. */
function random(seed: number): (below: number) => number {
	let state = seed >>> 0;
	return (below) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		// The high bits: an LCG's low bits repeat with short periods.
		return Math.floor((state / 2 ** 32) * below);
	};
}

const usage = (cost: number) => ({
	input: 3,
	output: 2,
	cacheRead: 1,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0, total: 2 * cost },
});
const reply = (text: string, at: number) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "p",
		model: "m",
		usage: usage(0.01),
		stopReason: "stop",
		timestamp: at,
	}) as never;

/** The catalog row `recordSession` writes for `session`. */
function catalogRow(session: SessionManager): CatalogEntry | undefined {
	let row: CatalogEntry | undefined;
	recordSession(
		{ saveCatalog: (_id: string, entry: CatalogEntry) => void (row = entry) } as unknown as SessionIndex,
		session,
	);
	return row;
}

/** Today's name lookup: the latest `session_info` entry, read backwards over every entry. */
function nameByScan(session: SessionManager): string | undefined {
	const entries = session.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

let saved: { home?: string; db?: string };
beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_AGENT_DB;
});
afterEach(async () => {
	// Forks and appends mirror to the database in the background: let them land before it closes.
	await sessionMirrorSettled();
	closeSharedAgentDb();
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("incremental session folds equal the full folds", () => {
	for (const seed of [1, 7, 42, 1234]) {
		it(`on a random sequence of appends, branches, compactions and switches (seed ${seed})`, () => {
			const pick = random(seed);
			const cwd = tmp();
			const manager = SessionManager.create(cwd, path.join(tmp(), "sessions"));
			const cursor = new EntryCursor();
			let seen: unknown[] = [];
			const incremental = new SpendScan();
			const reference = new SpendScan();
			let clock = Date.parse("2026-11-12T00:00:00Z");
			let memoryId = 0;
			const ids = () => manager.getEntries().map((entry) => entry.id);
			const branchIds = () => manager.getBranch().map((entry) => entry.id);
			const anyOf = <T>(list: readonly T[]): T | undefined => (list.length ? list[pick(list.length)] : undefined);
			const ops: Array<() => void> = [
				() => manager.appendMessage({ role: "user", content: `prompt ${clock}`, timestamp: (clock += 1000) }),
				() => manager.appendMessage(reply(`reply ${clock}`, (clock += 1000))),
				() => manager.appendMessage(reply("", (clock += 1000))),
				() => manager.appendUsage("summary", "p", "m", usage(0.02)),
				() => {
					const ids = [++memoryId, ++memoryId];
					manager.appendCustomMessageEntry(
						MEMORY_MESSAGE_TYPE,
						`${pick(2) ? MEMORY_HEADER : MEMORY_HEADER_AGAIN}\nnote`,
						false,
						{ ids, updated: [clock, clock] },
					);
				},
				() => manager.appendSessionInfo(pick(3) ? `name ${clock}` : "", pick(2) ? "auto" : "user"),
				() => {
					const target = anyOf(ids());
					if (target) manager.branch(target);
				},
				() => {
					const kept = pick(4) ? anyOf(branchIds()) : "gone";
					manager.appendCompaction("summary", kept ?? null, 100, undefined, false, usage(0.03));
				},
				() => {
					const target = anyOf(ids());
					if (target) manager.appendLabelChange(target, pick(2) ? "mark" : undefined);
				},
				() => manager.resetLeaf(),
			];
			const rare: Array<() => void> = [
				() => manager.newSession(),
				() => {
					const target = anyOf(ids());
					if (target) manager.createBranchedSession(target);
				},
			];
			for (let step = 0; step < 300; step++) {
				if (pick(40) === 0) anyOf(rare)!();
				else ops[pick(ops.length)]();
				// Reads skipped now and then, so one read sometimes covers several appends.
				if (pick(3) === 0) continue;

				const next = cursor.next(manager);
				seen = next.restart ? [...next.entries] : [...seen, ...next.entries];
				expect(seen).toEqual(manager.getEntries());

				expect(incremental.recordedIn(manager)).toEqual(reference.recorded(manager.getEntries()));

				const branch = manager.getBranch();
				expect(sessionInjections(manager)).toEqual({
					injected: injectedIds(branch),
					headerInContext: headerInContext(branch),
				});

				expect(manager.getSessionName()).toBe(nameByScan(manager));

				// A new object over the same manager has no cursor: its row is the full fold's.
				expect(catalogRow(manager)).toEqual(catalogRow(Object.create(manager) as SessionManager));
			}
		});
	}
});

describe("entry cursor fallbacks", () => {
	it("follows a session that copies its entries, through inserts, rollbacks and replacements", () => {
		const pick = random(99);
		let list: { id: string; type: string }[] = [];
		let next = 0;
		const make = () => ({ id: `e${next++}`, type: "custom" });
		// A copy of fresh objects on every read, as an adapter over another process would give.
		const source = { getEntries: () => list.map((entry) => ({ ...entry })) };
		const cursor = new EntryCursor();
		let seen: unknown[] = [];
		for (let step = 0; step < 500; step++) {
			const op = pick(10);
			if (op < 6) list.push(make());
			else if (op === 6 && list.length) list.pop();
			else if (op === 7 && list.length) list.splice(pick(list.length), 0, make());
			else if (op === 8) list = [make(), ...list.slice(pick(list.length + 1))];
			else list = list.slice(0, pick(list.length + 1));
			if (pick(2) === 0) continue;
			const read = cursor.next(source);
			seen = read.restart ? [...read.entries] : [...seen, ...read.entries];
			expect(seen).toEqual(list);
		}
	});

	it("reads appends without copying the session, and the whole session after a merge it cannot prove", () => {
		const manager = SessionManager.inMemory(tmp());
		for (let index = 0; index < 50; index++)
			manager.appendMessage({ role: "user", content: `m${index}`, timestamp: index });
		const cursor = new EntryCursor();
		expect(cursor.next(manager)).toMatchObject({ restart: true });
		const older = manager.getEntries()[10].id;
		const copies = { count: 0 };
		const getEntries = manager.getEntries.bind(manager);
		Object.assign(manager, {
			getEntries: () => {
				copies.count++;
				return getEntries();
			},
		});
		const id = manager.appendMessage({ role: "user", content: "after", timestamp: 99 });
		expect(cursor.next(manager)).toEqual({ restart: false, entries: [manager.getEntry(id)] });
		expect(cursor.next(manager)).toEqual({ restart: false, entries: [] });
		expect(copies.count).toBe(0);
		// An entry appended on another branch is not on the leaf's path: the list is read, and the read still resumes.
		const leaf = manager.getLeafId()!;
		manager.branch(older);
		const side = manager.appendMessage({ role: "user", content: "side", timestamp: 100 });
		manager.branch(leaf);
		const back = manager.appendMessage({ role: "user", content: "back", timestamp: 101 });
		expect(cursor.next(manager)).toEqual({
			restart: false,
			entries: [manager.getEntry(side), manager.getEntry(back)],
		});
		expect(copies.count).toBe(1);
	});
});
