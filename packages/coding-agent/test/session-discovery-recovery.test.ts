import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, SessionManager } from "../src/core/session-manager.ts";

describe("resuming recoverable session files", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-discovery-recovery-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("keeps a session with null message content visible in the resume picker", async () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "Keep this task", timestamp: 1 });
		manager.appendMessage({ role: "assistant", content: null, timestamp: 2 } as never);
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file, "utf8");
		expect(SessionManager.open(file).buildSessionContext().messages).toHaveLength(2);
		const listed = await SessionManager.list(dir, dir);
		expect(listed.map((item) => item.path)).toContain(file);
		expect(listed[0].firstMessage).toBe("Keep this task");
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});
	it("continues the valid session when another candidate is a broken symlink", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "Resume me", timestamp: 1 });
		symlinkSync(join(dir, "missing"), join(dir, "broken.jsonl"));
		expect(findMostRecentSession(dir, dir)).toBe(manager.getSessionFile());
		expect(SessionManager.continueRecent(dir, dir).getSessionId()).toBe(manager.getSessionId());
	});
	it("does not offer a session header without an identifier", async () => {
		writeFileSync(join(dir, "invalid.jsonl"), JSON.stringify({ type: "session", cwd: dir }) + "\n");
		expect(await SessionManager.list(dir, dir)).toEqual([]);
	});
});
