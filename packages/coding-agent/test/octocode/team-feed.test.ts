import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedEntry, Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { type AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { openWorkspaceDb } from "../../src/storage/workspace-database.ts";
import { endpointLabel, endpointOf, type EndpointDirectory } from "../../src/octocode/team/endpoint.ts";
import { messageEntry, noticeEntry, pageFeed, type FeedNotice } from "../../src/octocode/team/feed.ts";
import { readFeed, teamFeedSource } from "../../src/octocode/team/feed-read.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

let root: string;
const folders: string[] = [];
const folder = (name: string): string => {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	folders.push(dir);
	return dir;
};
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-feed-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("endpointOf", () => {
	it("names role, worktree, branch and tmux pane for each kind of member, and falls back to what is known", () => {
		const main = folder("main");
		const linked = folder("fix");
		const isolated = folder("iso");
		const members = [
			member("main-one", { checkout: main, cwd: main, branch: "trunk", sessionId: "s-main", tmuxPane: "%12" }),
			member("linked-one", { checkout: linked, cwd: linked, branch: "fix/x" }),
			member("kid", { role: "implementer", parentId: "main-one", checkout: main, cwd: isolated }),
		];
		const departed = new Map([
			["gone-kid", { role: "reviewer", parentId: "main-one", sessionId: "s-gone", cwd: isolated, branch: "b" }],
		]);
		const directory: EndpointDirectory = { members, departed: (id) => departed.get(id), root: main };

		expect(endpointOf("main-one", directory)).toEqual({
			id: "main-one",
			role: "main",
			sessionId: "s-main",
			worktree: "main",
			branch: "trunk",
			tmuxPane: "%12",
		});
		expect(endpointOf("linked-one", directory)).toMatchObject({ worktree: "worktree fix", branch: "fix/x" });
		expect(endpointOf("kid", directory)).toMatchObject({
			role: "implementer",
			parentId: "main-one",
			worktree: "worktree iso",
		});
		expect(endpointOf("gone-kid", directory)).toEqual({
			id: "gone-kid",
			role: "reviewer",
			parentId: "main-one",
			sessionId: "s-gone",
			worktree: "worktree iso",
			branch: "b",
			departed: true,
		});
		expect(endpointOf("stranger", directory)).toEqual({ id: "stranger" });
		expect(endpointOf("user", directory)).toEqual({ id: "user", role: "user" });
		expect(endpointOf("team", directory)).toEqual({ id: "team", role: "team" });
		expect(endpointLabel(endpointOf("main-one", directory), [{ id: "%12", label: "work:2.0" }])).toBe(
			"main-one (main) · main · trunk · tmux work:2.0",
		);
		expect(endpointLabel(endpointOf("gone-kid", directory))).toBe("gone-kid (reviewer, left) · worktree iso · b");
	});

	it("marks a worktree whose folder was removed, and names none without a viewer checkout", () => {
		const main = folder("main");
		const members = [member("lost", { checkout: path.join(root, "removed"), cwd: path.join(root, "removed") })];
		expect(endpointOf("lost", { members, root: main }).worktree).toBe("worktree removed (gone)");
		expect(endpointOf("lost", { members }).worktree).toBeUndefined();
	});
});

const traffic = (id: number, at: number, extra: Partial<Traffic> = {}): Traffic => ({
	id,
	from: "a",
	to: ["b"],
	text: `message ${id}`,
	at,
	state: "delivered",
	...extra,
});

describe("feed entries", () => {
	const directory: EndpointDirectory = { members: [member("a"), member("b", { role: "researcher" })] };

	it("carries both endpoints, per-recipient state and a link to the sender's transcript", () => {
		const entry = messageEntry(
			traffic(7, 100, { deliveries: [{ recipient: "b", state: "delivered", deliveredAt: 105 }], replyTo: 3 }),
			directory,
			(agentId, at) => ({ agentId, entry: at }),
		);
		expect(entry).toMatchObject({
			id: 7,
			from: { id: "a", role: "main" },
			to: [{ id: "b", role: "researcher" }],
			replyTo: 3,
			deliveries: [{ recipient: "b", state: "delivered", deliveredAt: 105 }],
			transcript: { agentId: "a", entry: 100 },
		});
		expect(entry.internal).toBeUndefined();
	});

	it("flags an internal notice and links the receiver's own entry", () => {
		const notice: FeedNotice = {
			agentId: "b",
			sessionId: "s-b",
			entry: 4,
			entryId: "e1.0",
			at: 50,
			label: "octocode-agent-message",
			from: "team",
			text: "Your lease lapsed",
		};
		const entry = noticeEntry(notice, directory);
		expect(entry).toMatchObject({
			internal: true,
			from: { id: "team", role: "team" },
			to: [{ id: "b" }],
			transcript: { agentId: "b", sessionId: "s-b", entry: 4 },
		});
		expect(entry.id).toBeUndefined();
		expect(noticeEntry({ ...notice, from: "cli-tool", external: true }, directory).from).toEqual({
			id: "cli-tool",
			role: "external",
		});
	});

	it("pages 75 entries newest first with no gap or repeat, and can hide internal ones", () => {
		const entries: FeedEntry[] = Array.from({ length: 75 }, (_, i) =>
			messageEntry(traffic(i + 1, 1000 + (i % 7)), directory),
		);
		const notice = noticeEntry(
			{ agentId: "b", entry: 1, entryId: "n", at: 1003, label: "x", from: "team", text: "hi" },
			directory,
		);
		const all = [...entries, notice];
		const seen: string[] = [];
		let page = pageFeed(all, { limit: 30 });
		for (;;) {
			expect(page.entries.length).toBeLessThanOrEqual(30);
			seen.push(...page.entries.map((entry) => entry.key));
			if (!page.next) break;
			page = pageFeed(all, { limit: 30, before: page.next });
		}
		expect(seen).toHaveLength(76);
		expect(new Set(seen).size).toBe(76);
		expect(pageFeed(all, { internal: false, limit: 100 }).entries).toHaveLength(75);
		expect(pageFeed(all, { limit: 100 }).next).toBeUndefined();
	});
});

describe("the team feed from the database", () => {
	let db: AgentDb;
	let rows: AgentDb;
	let store: TeamStore;
	beforeEach(() => {
		fs.mkdirSync(path.join(root, ".git"));
		fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/feed\n");
		vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
		db = openAgentDb();
		rows = openWorkspaceDb(db, root).agent;
		store = TeamStore.open(root, db.file);
		store.lifecycle = { activationId: "start", sessionId: "session-main" };
	});
	afterEach(() => {
		store.close();
		if (rows !== db) rows.close();
		db.close();
		vi.unstubAllEnvs();
	});

	it("lists history past 30 messages in pages, and resolves an agent that left from its delete event", () => {
		const fresh = { joinedAt: Date.now(), updatedAt: Date.now() };
		const alpha = member("alpha", { role: "main", sessionId: "s-alpha", ...fresh });
		const beta = member("beta", { role: "implementer", parentId: "alpha", sessionId: "s-beta", ...fresh });
		store.join(alpha);
		store.join(beta);
		const now = Date.now();
		for (let i = 0; i < 75; i++)
			store.send(i % 2 ? "beta" : "alpha", [i % 2 ? "alpha" : "beta"], `body ${i}`, { replyRequired: false }, now + i);
		const source = (members: () => Member[]) => teamFeedSource({ db: rows.db, team: store.team, members, root });
		const live = source(() => store.list());

		const first = readFeed(live);
		expect(first.entries).toHaveLength(30);
		expect(first.entries[0]?.text).toBe("body 74");
		expect(first.entries[0]?.from).toMatchObject({
			id: "alpha",
			role: "main",
			worktree: "main",
			branch: "feature/feed",
		});
		expect(first.entries[0]?.deliveries).toEqual([{ recipient: "beta", state: "queued" }]);
		const seen = [...first.entries];
		for (let page = first; page.next;) {
			page = readFeed(live, { before: page.next });
			seen.push(...page.entries);
		}
		expect(seen.map((entry) => entry.text)).toEqual(Array.from({ length: 75 }, (_, i) => `body ${74 - i}`));

		store.remove("beta", Date.now(), beta, "completed");
		const after = readFeed(
			source(() => store.list()),
			{ limit: 2 },
		);
		expect(after.entries[1]?.from).toMatchObject({
			id: "beta",
			role: "implementer",
			parentId: "alpha",
			sessionId: "session-main",
			departed: true,
			branch: "feature/feed",
		});
		expect(after.entries[1]?.to[0]).toMatchObject({ id: "alpha", role: "main" });
		expect(after.next).toBeDefined();
	});
});
