import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	restoreLimits,
	RESTORE_FILE_CHARS,
	RESTORE_MAX_FILES,
	RESTORE_TOTAL_CHARS,
} from "../../src/octocode/compaction/restore.ts";
import { PINNED_BUDGET, selectInjection } from "../../src/octocode/memory/inject.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { readNotes } from "../../src/octocode/memory/session-notes-tool.ts";
import { sessionNotes, SESSION_NOTE_TYPE } from "../../src/octocode/memory/session-notes.ts";
import { memoryStore, MemoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-reinject-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const NOTE = "Never run the migrations against production; use the staging copy";

function harness() {
	const session = SessionManager.inMemory(cwd);
	const fake = fakeHost();
	Object.assign(fake.api.session, {
		appendEntry: (type: string, data?: unknown) => session.appendCustomEntry(type, data),
	});
	registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		permission: fakePermission("workspace", { api: fake.api }),
	});
	const ctx = () =>
		Object.assign(fakeCtx({ cwd, hasUI: true, ui: { selects: [], inputs: [] } }), {
			isProjectTrusted: () => true,
			sessionManager: session,
		});
	const tool = (params: Record<string, unknown>) =>
		fake.tools.get("memory").execute("call", params, undefined, undefined, ctx());
	/** What an overflow compaction does: a summary replaces the history, then `session_compact` announces it. */
	const overflowCompaction = async (willRetry = true) => {
		const kept = session.appendMessage({ role: "user", content: "later question", timestamp: Date.now() } as never);
		const compactionId = session.appendCompaction("Earlier work", kept, 100);
		fake.sent.length = 0;
		await fake.fire(
			"session_compact",
			{ reason: "overflow", willRetry, fromFeature: false, compactionEntry: session.getEntry(compactionId) },
			ctx(),
		);
		return fake.sent.map((sent) => sent.message as { customType: string; content: string; details: unknown });
	};
	return { session, fake, tool, ctx, overflowCompaction };
}

describe("memory after an overflow compaction", () => {
	it("sends the session notes and pinned memories again before the retry", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE, kind: "decision" });
		memoryStore(cwd).set({ title: "Use tabs", body: "Indent with tabs", pinned: true, author: "user" });
		const sent = await h.overflowCompaction();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("octocode-memory");
		expect(sent[0]?.content).toContain(JSON.stringify(NOTE));
		expect(sent[0]?.content).toContain("Use tabs");
		expect(h.fake.sent[0]?.options).toMatchObject({ triggerTurn: false });
	});

	it("sends nothing when the compaction is not retried or nothing is missing", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		expect(await h.overflowCompaction(false)).toHaveLength(0);
		const empty = harness();
		expect(await empty.overflowCompaction()).toHaveLength(0);
	});
});

describe("session notes", () => {
	it("answers an invalid search pattern with an error, not an exception from the regex engine", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		expect(() => readNotes(h.ctx(), { query: "(unclosed" })).toThrow(/not a valid regular expression/);
		expect(() => readNotes(h.ctx(), { query: "a".repeat(500) })).toThrow(/at most 200/);
		const ok = await h.tool({ op: "search", scope: "session", query: "stag(ing)" });
		expect(ok.content[0].text).toContain("Staging only");
	});

	it("reads an entry with an unknown kind as a fact", () => {
		const session = SessionManager.inMemory(cwd);
		session.appendCustomEntry(SESSION_NOTE_TYPE, {
			version: 1,
			op: "set",
			id: 1,
			title: "T",
			body: "B",
			kind: "bogus",
			at: 1,
		});
		expect(sessionNotes(session).notes.get(1)?.kind).toBe("fact");
		session.appendCustomEntry(SESSION_NOTE_TYPE, { version: 1, op: "set", id: 1, kind: "gotcha", at: 2 });
		session.appendCustomEntry(SESSION_NOTE_TYPE, { version: 1, op: "set", id: 1, kind: "nope", at: 3 });
		expect(sessionNotes(session).notes.get(1)?.kind).toBe("gotcha");
	});
});

/** Letters-only words, each index its own word, so generated fixtures share nothing. */
const word = (n: number) => `${n.toString(26).replace(/[0-9]/g, (d) => String.fromCharCode(113 + Number(d)))}qz`;
const words = (i: number, count = 6) => Array.from({ length: count }, (_, k) => word(i * 20 + k + 1000)).join(" ");

describe("duplicate check", () => {
	it("refuses a workspace memory that repeats a global one, and finds it past 200 newer memories", () => {
		const db = openAgentDb(path.join(root, "agent.db"));
		try {
			const store = new MemoryStore(db, "repo-a");
			const global = store.set({ title: "Prefers tabs for indentation", scope: "global", author: "test" }).memory;
			for (let i = 0; i < 230; i++) store.set({ title: words(i), author: "test" }, 10_000 + i);
			expect(() => store.set({ title: "Prefers tabs for indentation", scope: "project", author: "test" })).toThrow(
				new RegExp(`Similar memory M${global.id}`),
			);
		} finally {
			db.close();
		}
	});
});

describe("window-derived sizes", () => {
	it("keeps the current values on small or unknown windows and grows them on large ones", () => {
		for (const window of [undefined, 8_000, 32_000, 200_000]) {
			expect(restoreLimits(window)).toEqual({
				maxFiles: RESTORE_MAX_FILES,
				fileChars: RESTORE_FILE_CHARS,
				outlineChars: 4_000,
				totalChars: RESTORE_TOTAL_CHARS,
			});
		}
		expect(restoreLimits(1_000_000).totalChars).toBe(RESTORE_TOTAL_CHARS * 5);
	});

	it("injects more pinned memories on a large window than the floor allows", () => {
		const db = openAgentDb(path.join(root, "budget.db"));
		try {
			const store = new MemoryStore(db, "repo-b");
			for (let i = 0; i < 40; i++)
				store.set({
					title: words(i),
					body: words(i + 100, 12),
					pinned: true,
					author: "test",
				});
			const base = { query: "", scope: "all" as const, seen: new Set<number>(), topK: 5 };
			const floor = selectInjection(store, { ...base, contextWindow: 32_000 })!;
			const same = selectInjection(store, base)!;
			const large = selectInjection(store, { ...base, contextWindow: 1_000_000 })!;
			expect(floor.ids).toEqual(same.ids);
			expect(floor.content.length).toBeLessThanOrEqual(PINNED_BUDGET * 2);
			expect(large.ids.length).toBeGreaterThan(floor.ids.length);
		} finally {
			db.close();
		}
	});
});
