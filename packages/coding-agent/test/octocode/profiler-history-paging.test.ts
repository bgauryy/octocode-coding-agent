import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedCursor, Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { AgentDb } from "../../../db/src/api.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { involvedHistory, readHistory } from "../../src/octocode/workspace/team-history.ts";

const member = (id: string, parentId?: string): Member => ({
	id,
	role: parentId ? "implementer" : "main",
	...(parentId ? { parentId } : {}),
	pid: process.pid,
	status: "idle",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

let root: string;
let db: AgentDb;
let store: TeamStore;
const mine = new Set(["alpha", "beta"]);
const involved = (message: Traffic) => mine.has(message.from) || message.to.some((id) => mine.has(id));

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profiler-history-")));
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
	store = TeamStore.open(root, db.file);
	store.lifecycle = { activationId: "start", sessionId: "session-main" };
	for (const id of ["alpha", "gamma", "delta"]) store.join(member(id));
	store.join(member("beta", "alpha"));
});
afterEach(() => {
	store.close();
	db.close();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

/** 90 messages: every third involves this session (alpha, beta); the others are between gamma and delta. */
function send(): number[] {
	const now = Date.now();
	const ids: number[] = [];
	for (let i = 0; i < 90; i++) {
		const pair = i % 3 === 0 ? ["alpha", "beta"] : ["gamma", "delta"];
		const [from, to] = i % 2 ? pair : [pair[1], pair[0]];
		const sent = store.send(from, [to], `body ${i}`, { replyRequired: false }, now + i);
		if (involved({ from, to: [to] } as Traffic)) ids.push(sent.id as number);
	}
	return ids.reverse();
}

function pages(limit: number, maxScan?: number): Array<{ ids: number[]; next?: FeedCursor }> {
	const read = readHistory(workspaceDb(root).agent.db, store.team);
	const out: Array<{ ids: number[]; next?: FeedCursor }> = [];
	let before: FeedCursor | undefined;
	for (let guard = 0; guard < 200; guard++) {
		const page = involvedHistory(read, involved, limit, before, maxScan);
		out.push({ ids: page.traffic.map((message) => message.id), ...(page.next ? { next: page.next } : {}) });
		if (!page.next) return out;
		before = page.next;
	}
	throw new Error("paging did not end");
}

describe("this session's messages paged from the team database", () => {
	it("pages through more than two pages of mixed messages with no gap and no repeat", () => {
		const expected = send();
		const result = pages(10);
		expect(result.length).toBeGreaterThan(2);
		const seen = result.flatMap((page) => page.ids);
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(expected.length);
		expect(result.at(-1)?.next).toBeUndefined();
	});

	it("continues with an empty page when a scan fills with other sessions' messages", () => {
		const expected = send();
		// Two of every three rows are not ours: a scan of 2 rows sometimes keeps none, and still hands back a cursor.
		const result = pages(10, 2);
		expect(result.some((page) => page.ids.length === 0 && page.next !== undefined)).toBe(true);
		const seen = result.flatMap((page) => page.ids);
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(expected.length);
	});

	it("returns no cursor when the history is exhausted inside one page", () => {
		const expected = send();
		const page = involvedHistory(readHistory(workspaceDb(root).agent.db, store.team), involved, 500);
		expect(page.traffic.map((message) => message.id)).toEqual(expected);
		expect(page.next).toBeUndefined();
	});
});
