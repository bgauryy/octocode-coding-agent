import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../src/core/compaction/branch-summarization.ts";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";

// A damaged or hand-edited session file can link an entry to itself or close a loop of parent links.
// Every walk toward the root must still end, and the session must stay usable.

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string) {
	const body =
		role === "user"
			? { role, content: text, timestamp: 1 }
			: {
					role,
					content: [{ type: "text", text }],
					provider: "anthropic",
					model: "claude-test",
					api: "anthropic-messages",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason: "stop",
					timestamp: 1,
				};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: body };
}

function texts(manager: SessionManager): string[] {
	return manager.buildSessionContext().messages.map((m) => {
		if (!("content" in m)) return "";
		return typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("");
	});
}

describe("session files whose parent links loop", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-parent-cycles-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function writeSession(name: string, entries: object[]): string {
		const file = join(dir, name);
		const header = { type: "session", version: 3, id: name.replace(".jsonl", ""), timestamp: "t", cwd: dir };
		writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	it("opens a session with an entry that is its own parent and treats that entry as a root", () => {
		const file = writeSession("self-parent.jsonl", [
			message("aaaa0001", null, "user", "lost"),
			message("aaaa0002", "aaaa0002", "user", "self"),
			message("aaaa0003", "aaaa0002", "assistant", "reply"),
		]);
		const manager = SessionManager.open(file, dir);

		expect(manager.getBranch().map((e) => e.id)).toEqual(["aaaa0002", "aaaa0003"]);
		expect(texts(manager)).toEqual(["self", "reply"]);
		expect(manager.getTree().map((node) => node.entry.id)).toEqual(["aaaa0001", "aaaa0002"]);

		const next = manager.appendMessage({ role: "user", content: "after", timestamp: 2 });
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getLeafId()).toBe(next);
		expect(texts(reopened)).toEqual(["self", "reply", "after"]);
		expect(readFileSync(file, "utf8")).toContain('"parentId":"aaaa0002"');
	});

	it("opens a session whose two entries name each other as parent, and every walk ends", () => {
		const file = writeSession("two-cycle.jsonl", [
			message("bbbb0001", null, "user", "root"),
			message("bbbb0002", "bbbb0003", "user", "first"),
			message("bbbb0003", "bbbb0002", "assistant", "second"),
			message("bbbb0004", "bbbb0003", "user", "leaf"),
		]);
		const manager = SessionManager.open(file, dir);

		expect(manager.getBranch().map((e) => e.id)).toEqual(["bbbb0002", "bbbb0003", "bbbb0004"]);
		expect(texts(manager)).toEqual(["first", "second", "leaf"]);
		expect(manager.getBranch("bbbb0002").map((e) => e.id)).toEqual(["bbbb0003", "bbbb0002"]);

		// The exported pure projection takes raw entries and must end as well.
		const raw = buildSessionContext(manager.getEntries(), "bbbb0004");
		expect(raw.messages).toHaveLength(3);

		// Navigating from the loop to the separate root summarizes each loop entry once.
		const collected = collectEntriesForBranchSummary(manager, "bbbb0004", "bbbb0001");
		expect(collected.commonAncestorId).toBeNull();
		expect(collected.entries.map((e) => e.id)).toEqual(["bbbb0002", "bbbb0003", "bbbb0004"]);
	});
});
