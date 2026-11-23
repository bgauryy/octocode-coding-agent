/** `/messages`: rows, marks, the internal toggle, paging and the expanded page, driven through a scripted page shower. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { type AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import type { PageChoice } from "../../src/octocode/shared/page.ts";
import type { FeedNotice } from "../../src/octocode/team/feed.ts";
import { type FeedSource, readFeed } from "../../src/octocode/team/feed-read.ts";
import { messagesPage, messagesText, type ShowPage, TOGGLE_KEY } from "../../src/octocode/team/messages/page.ts";
import { feedHeader } from "../../src/octocode/team/messages/row.ts";
import { messagesPorts } from "../../src/octocode/profiler/messages-source.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
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
	...extra,
});

let root: string;
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "messages-page-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const folder = (name: string): string => {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

type Options = Parameters<ShowPage>[1];

/** Answers each page in turn with the next scripted choice, and records the options each page was shown with. */
function script(choices: Array<(options: Options) => PageChoice | undefined>): { show: ShowPage; shown: Options[] } {
	const shown: Options[] = [];
	return {
		shown,
		show: async (_ui, options) => {
			shown.push(options);
			const next = choices.shift();
			if (!next) throw new Error(`unscripted page ${options.title}`);
			return next(options);
		},
	};
}

const ui = { custom: () => Promise.reject(new Error("the scripted shower owns the page")) };
const rowsOf = (options: Options) => options.sections.flatMap((section) => [...section.rows]);
const factsOf = (options: Options) => Object.fromEntries((options.facts ?? []).map((fact) => [fact.label, fact.value]));
const escape = () => undefined;

describe("messages page over a fake feed", () => {
	let main: string;
	let members: Member[];
	const BODY = "first line\nsecond line\nthird line";
	const NOW = Date.now();

	const traffic = (count: number): Traffic[] =>
		Array.from({ length: count }, (_, i) => ({
			id: i + 1,
			from: "alpha",
			to: ["beta"],
			text: i === count - 1 ? BODY : `body ${i + 1}`,
			at: NOW - (count - i) * 1000,
			state: "delivered" as const,
		}));

	function source(all: Traffic[], notices: FeedNotice[] = []): FeedSource {
		const newestFirst = [...all].sort((a, b) => b.at - a.at || b.id - a.id);
		return {
			traffic: (limit, before) =>
				newestFirst
					.filter(
						(message) => !before || message.at < before.at || (message.at === before.at && message.id < before.id),
					)
					.slice(0, limit),
			directory: () => ({ members, root: main }),
			notices: () => notices,
		};
	}

	const notice: FeedNotice = {
		agentId: "beta",
		entry: 4,
		entryId: "c1.0",
		at: NOW - 500,
		label: "octocode-agent-message",
		from: "team",
		text: "alpha went quiet",
	};

	beforeEach(() => {
		main = folder("main");
		const isolated = folder("iso");
		members = [
			member("alpha", { checkout: main, cwd: main, tmuxPane: "%3", branch: "trunk" }),
			member("beta", { role: "implementer", parentId: "alpha", checkout: main, cwd: isolated }),
		];
	});

	it("names sender and the real recipient with roles and marks, never `you`", async () => {
		const { show, shown } = script([escape]);
		await messagesPage({ feed: source(traffic(3)), transcript: () => undefined, ui, show });
		const [first] = rowsOf(shown[0]);
		expect(first.name).toBe("#3");
		expect(first.detail).toMatch(
			/^alpha\(main\) \[main, trunk, tmux pane %3\] → beta\(implementer\) \[worktree iso\] · FYI · \d\d:\d\d:\d\d$/,
		);
		expect(first.badge).toBe("delivered");
		expect(JSON.stringify(shown[0])).not.toContain("you");
		expect(rowsOf(shown[0]).map((row) => row.name)).toEqual(["#3", "#2", "#1"]);
		// The header form the transcript rows share.
		const { entries } = readFeed(source(traffic(3)));
		expect(feedHeader(entries[0])).toMatch(
			/^alpha\(main\) \[.*\] → beta\(implementer\) \[worktree iso\] · #3 · FYI · /,
		);
	});

	it("hides internal notices until the toggle key shows them, and says which it is on", async () => {
		const { show, shown } = script([
			(options) => ({ id: rowsOf(options)[0].id, key: TOGGLE_KEY }),
			(options) => ({ id: rowsOf(options)[0].id, key: TOGGLE_KEY }),
			escape,
		]);
		await messagesPage({ feed: source(traffic(2), [notice]), transcript: () => undefined, ui, show });
		const [hidden, withNotices, hiddenAgain] = shown;
		expect(rowsOf(hidden).map((row) => row.name)).toEqual(["#2", "#1"]);
		expect(hidden.notes?.join(" ")).toContain("Internal notices hidden · i shows them");
		expect(rowsOf(hidden)[0].keys).toEqual({ i: "show internal" });
		expect(rowsOf(withNotices).map((row) => row.name)).toEqual(["notice", "#2", "#1"]);
		expect(rowsOf(withNotices)[0].detail).toMatch(/^team\(team\) → beta\(implementer\).* · octocode-agent-message · /);
		expect(withNotices.notes?.join(" ")).toContain("Internal notices shown");
		expect(rowsOf(withNotices)[0].keys).toEqual({ i: "hide internal" });
		expect(rowsOf(hiddenAgain).map((row) => row.name)).toEqual(["#2", "#1"]);
	});

	it("opens with notices shown when asked, and shows a placeholder row for an empty feed", async () => {
		const empty = script([escape]);
		await messagesPage({ feed: source([]), transcript: () => undefined, ui, show: empty.show });
		expect(rowsOf(empty.shown[0]).map((row) => [row.id, row.keys])).toEqual([["none", { i: "show internal" }]]);
		const open = script([escape]);
		await messagesPage({ feed: source([]), transcript: () => undefined, ui, show: open.show, internal: true });
		expect(open.shown[0].notes?.join(" ")).toContain("Internal notices shown");
	});

	it("pages 75 messages 30 at a time through the older row, with no gap or repeat", async () => {
		const { show, shown } = script([
			(options) => ({ id: rowsOf(options).at(-1)!.id }),
			(options) => ({ id: rowsOf(options).at(-1)!.id }),
			escape,
		]);
		await messagesPage({ feed: source(traffic(75)), transcript: () => undefined, ui, show, pageSize: 30 });
		expect(shown.map((options) => rowsOf(options).length)).toEqual([31, 61, 75]);
		const last = rowsOf(shown[2]);
		expect(last.some((row) => row.id === "older")).toBe(false);
		expect(last.map((row) => row.name)).toEqual(Array.from({ length: 75 }, (_, i) => `#${75 - i}`));
		// After loading, the cursor lands on the first of the newly loaded rows.
		expect(shown[1].initialId).toBe(rowsOf(shown[1])[30].id);
		expect(shown[1].notes?.join(" ")).toContain("60 loaded");
	});

	it("Enter opens the whole body and the sender's thinking and output; Escape goes back, then closes", async () => {
		const reads: unknown[] = [];
		const { show, shown } = script([(options) => ({ id: rowsOf(options)[0].id }), escape, escape]);
		await messagesPage({
			feed: { ...source(traffic(3)), transcriptNear: (agentId, at) => ({ agentId, entry: at % 7 }) },
			transcript: (ref) => {
				reads.push(ref);
				return {
					entry: ref.entry,
					role: "assistant",
					at: 0,
					thinking: "weigh the options\nthen reply",
					text: "sent it",
					tools: ["agent"],
				};
			},
			ui,
			show,
		});
		const page = shown[1];
		expect(page.title).toBe("Message #3");
		expect(page.nested).toBe(true);
		const facts = factsOf(page);
		expect(facts.From).toBe("alpha (main) · main · trunk · tmux pane %3");
		expect(facts.To).toBe("beta (implementer) · worktree iso · delivered");
		expect(facts.Body).toBe(BODY);
		expect(facts.Thinking).toBe("weigh the options\nthen reply");
		expect(facts.Output).toBe("sent it");
		expect(facts.Tools).toBe("agent");
		expect(reads).toHaveLength(1);
		// Back on the list with the same row selected, then Escape closes.
		expect(shown[2].initialId).toBe(rowsOf(shown[0])[0].id);
		expect(shown).toHaveLength(3);
	});

	it("says so when the sender has no transcript, and shows a notice as itself", async () => {
		const { show, shown } = script([
			(options) => ({ id: rowsOf(options).find((row) => row.name === "#1")!.id }),
			escape,
			(options) => ({ id: rowsOf(options).find((row) => row.name === "notice")!.id }),
			escape,
			escape,
		]);
		await messagesPage({ feed: source(traffic(1), [notice]), transcript: () => undefined, ui, show, internal: true });
		expect(factsOf(shown[1]).Transcript).toBe("none recorded for the sender");
		expect(shown[3].title).toBe("Notice");
		expect(factsOf(shown[3]).Body).toBe("alpha went quiet");
		expect(factsOf(shown[3]).Notice).toContain("octocode-agent-message");
		expect(factsOf(shown[3]).Thinking).toBeUndefined();
	});

	it("says so when the linked transcript is not on disk", async () => {
		const { show, shown } = script([(options) => ({ id: rowsOf(options)[0].id }), escape, escape]);
		await messagesPage({
			feed: { ...source(traffic(1)), transcriptNear: (agentId) => ({ agentId, entry: 1 }) },
			transcript: () => undefined,
			ui,
			show,
		});
		expect(factsOf(shown[1]).Transcript).toBe("alpha's transcript is not on disk");
	});

	it("prints the first page as plain lines without a UI", () => {
		const text = messagesText(source(traffic(40)), false, 30);
		expect(text.split("\n")).toHaveLength(31);
		expect(text).toContain("older messages exist");
		expect(messagesText(source([]), false)).toBe("No messages yet.");
	});
});

describe("messages page over the team database and transcript files", () => {
	let db: AgentDb;
	let store: TeamStore;
	beforeEach(() => {
		fs.mkdirSync(path.join(root, ".git"));
		fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
		db = openAgentDb();
		store = TeamStore.open(root, db.file);
		store.lifecycle = { activationId: "start", sessionId: "session-main" };
	});
	afterEach(() => {
		store.close();
		db.close();
		vi.unstubAllEnvs();
	});

	it("reads a session whose transcript is not written yet (no message sent) as one with no notices", async () => {
		store.join(member("alpha", { sessionId: "s-alpha", checkout: root, cwd: root }));
		const ports = messagesPorts({
			db: db.db,
			team: store.team,
			members: () => store.list(),
			root,
			ownId: "alpha",
			ownFile: () => path.join(root, "not-written-yet.jsonl"),
		});
		const { show, shown } = script([escape]);
		await messagesPage({ ...ports, ui, show, internal: true });
		expect(rowsOf(shown[0]).map((row) => row.name)).toEqual(["none"]);
		expect(messagesText(ports.feed, true)).toBe("No messages yet.");
	});

	it("links the sender's reply near the send and reads the notices its own transcript holds", async () => {
		store.join(member("alpha", { sessionId: "s-alpha", checkout: root, cwd: root }));
		store.join(member("beta", { role: "implementer", parentId: "alpha", checkout: root, cwd: root }));
		const sentAt = Date.now();
		store.send("alpha", ["beta"], "please review the diff", { replyRequired: true }, sentAt);
		const stamp = (ms: number) => new Date(sentAt + ms).toISOString();
		const file = path.join(root, "alpha.jsonl");
		const lines = [
			{ type: "session", id: "s-alpha", timestamp: stamp(-5000) },
			{
				type: "message",
				id: "a1",
				timestamp: stamp(-100),
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "the diff is risky, ask beta" },
						{ type: "text", text: "asking beta to review" },
					],
					usage: {},
					model: "m",
					stopReason: "stop",
				},
			},
			{
				type: "custom_message",
				id: "c1",
				timestamp: stamp(50),
				customType: "octocode-agent-message",
				content: "check in",
				details: { messages: [{ from: "team", text: "beta went quiet", at: sentAt + 50 }] },
			},
		];
		fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
		const ports = messagesPorts({
			db: db.db,
			team: store.team,
			members: () => store.list(),
			root,
			ownId: "alpha",
			ownFile: () => file,
		});
		const { show, shown } = script([
			(options) => ({ id: rowsOf(options).find((row) => /^#\d+$/.test(row.name))!.id }),
			escape,
			escape,
		]);
		await messagesPage({ ...ports, ui, show, internal: true });
		expect(rowsOf(shown[0]).map((row) => row.name)).toEqual(["notice", expect.stringMatching(/^#\d+$/)]);
		const facts = factsOf(shown[1]);
		expect(facts.Body).toBe("please review the diff");
		expect(facts.Thinking).toBe("the diff is risky, ask beta");
		expect(facts.Output).toBe("asking beta to review");
		expect(rowsOf(shown[0])[1].badge).toBe("queued");
		expect(rowsOf(shown[0])[1].detail).toContain("request");
	});
});
