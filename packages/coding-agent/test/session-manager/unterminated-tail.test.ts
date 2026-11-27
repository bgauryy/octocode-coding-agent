import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// A session whose final record is whole but lacks its newline (a hand edit, or a writer stopped just before it).
// Reading such a file must not write it; the next append, under the session lock, ends the record first.

const asRoot = process.getuid?.() === 0;

describe("a session file whose final record lacks its newline", () => {
	let dir: string;
	let file: string;
	let content: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-unterminated-"));
		file = join(dir, "session.jsonl");
		content = [
			JSON.stringify({ type: "session", version: 3, id: "unterminated", timestamp: "t", cwd: dir }),
			JSON.stringify({
				type: "message",
				id: "dddd0001",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "kept", timestamp: 1 },
			}),
		].join("\n");
		writeFileSync(file, content);
	});
	afterEach(() => {
		chmodSync(file, 0o644);
		rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(asRoot)("opens and forks a read-only copy without writing it", () => {
		chmodSync(file, 0o444);
		expect(
			SessionManager.open(file, dir)
				.getEntries()
				.map((e) => e.id),
		).toEqual(["dddd0001"]);
		const fork = SessionManager.forkFrom(file, dir, join(dir, "forks"));
		expect(fork.buildSessionContext().messages).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("ends the record before the next append, so every record keeps its own line", () => {
		const opened = SessionManager.open(file, dir);
		expect(readFileSync(file, "utf8")).toBe(content);
		opened.appendMessage({ role: "user", content: "next", timestamp: 2 });

		const lines = readFileSync(file, "utf8").split("\n");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1).map((line) => JSON.parse(line).type)).toEqual(["session", "message", "message"]);
		const reopened = SessionManager.open(file, dir);
		expect(reopened.buildSessionContext().messages.map((m) => ("content" in m ? m.content : ""))).toEqual([
			"kept",
			"next",
		]);
	});

	it("ends the record before the next append after switching to the file", () => {
		const manager = SessionManager.create(dir, dir);
		manager.setSessionFile(file);
		manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
		expect(SessionManager.open(file, dir).getEntries()).toHaveLength(2);
		expect(readFileSync(file, "utf8").startsWith(`${content}\n{`)).toBe(true);
	});
});
