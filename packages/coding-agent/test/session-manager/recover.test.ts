import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repairSessionFile, SessionManager } from "../../src/core/session-manager.ts";

describe("session repair after a torn final record", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-recover-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function tornSession() {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const file = manager.getSessionFile()!;
		const intact = readFileSync(file, "utf8");
		// A power loss mid-append: half of a record, no newline.
		appendFileSync(file, '{"type":"message","id":"torn","parentId":null,"timesta');
		return { file, intact, torn: readFileSync(file, "utf8") };
	}

	it("repairs a reopened session's torn tail into a backup, then writes work", () => {
		const { file, intact, torn } = tornSession();
		const reopened = SessionManager.open(file, dir);

		const repair = reopened.recover();

		expect(repair).toMatchObject({ file, backup: `${file}.bak`, removedBytes: torn.length - intact.length });
		expect(readFileSync(`${file}.bak`, "utf8")).toBe(torn);
		expect(readFileSync(file, "utf8")).toBe(intact);
		const id = reopened.appendMessage({ role: "user", content: "after repair", timestamp: 3 });
		expect(readFileSync(file, "utf8")).toBe(`${intact}${JSON.stringify(reopened.getEntry(id))}\n`);
		expect(SessionManager.open(file, dir).getEntries()).toHaveLength(3);
	});

	it("clears the write block a failed append left", () => {
		const { file, intact } = tornSession();
		const manager = SessionManager.open(file, dir);
		// Another process replaced the file with a shorter one: refused, and the refusal sticks.
		writeFileSync(file, intact.slice(0, intact.lastIndexOf("\n", intact.length - 2) + 1));
		expect(() => manager.appendMessage({ role: "user", content: "x", timestamp: 3 })).toThrow(/shrank/);
		expect(() => manager.appendMessage({ role: "user", content: "y", timestamp: 4 })).toThrow(/blocked|shrank/);

		manager.recover();

		expect(() => manager.appendMessage({ role: "user", content: "z", timestamp: 5 })).not.toThrow();
	});

	it("does nothing when the tail is complete, and never overwrites an earlier backup", () => {
		const { file, intact } = tornSession();
		expect(repairSessionFile(file)?.backup).toBe(`${file}.bak`);
		expect(repairSessionFile(file)).toBeUndefined();
		expect(existsSync(`${file}.1.bak`)).toBe(false);

		appendFileSync(file, "{torn");
		expect(repairSessionFile(file)?.backup).toBe(`${file}.1.bak`);
		expect(readFileSync(file, "utf8")).toBe(intact);
	});

	it("refuses a file with no complete record and leaves it untouched", () => {
		const file = join(dir, "headless.jsonl");
		writeFileSync(file, '{"type":"session","id":"a');
		expect(() => repairSessionFile(file)).toThrow(/no complete record/);
		expect(readFileSync(file, "utf8")).toBe('{"type":"session","id":"a');
		expect(existsSync(`${file}.bak`)).toBe(false);
	});

	it("keeps the transcript in memory when the first write failed before the file existed", () => {
		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir);
		const manager = SessionManager.create(dir, sessionDir);
		const sessionId = manager.getSessionId();
		const modelEntry = manager.appendModelChange("p", "m");
		chmodSync(sessionDir, 0o500);
		try {
			expect(() => manager.appendMessage({ role: "user", content: "lost?", timestamp: 1 })).toThrow(
				/persistence failed/,
			);
		} finally {
			chmodSync(sessionDir, 0o700);
		}
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(false);

		expect(manager.recover()).toBeUndefined();

		expect(manager.getSessionId()).toBe(sessionId);
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getEntry(modelEntry)).toBeDefined();
		const id = manager.appendMessage({ role: "user", content: "again", timestamp: 2 });
		const reopened = SessionManager.open(file, sessionDir);
		expect(reopened.getSessionId()).toBe(sessionId);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([modelEntry, id]);
	});

	it("refuses to recover an in-memory session", () => {
		expect(() => SessionManager.inMemory(dir).recover()).toThrow(/persistence is disabled/);
	});
});
