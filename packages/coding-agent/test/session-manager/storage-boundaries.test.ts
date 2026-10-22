import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("session storage boundaries", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-storage-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps the original write destination after an invalid session switch", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const originalFile = manager.getSessionFile()!;
		const invalidFile = join(dir, "invalid.jsonl");
		const invalid = '{"type":"other"}\n';
		writeFileSync(invalidFile, invalid);
		expect(() => manager.setSessionFile(invalidFile)).toThrow("not a valid");
		expect(manager.getSessionFile()).toBe(originalFile);
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		expect(readFileSync(invalidFile, "utf8")).toBe(invalid);
		expect(SessionManager.open(originalFile).buildSessionContext().messages).toHaveLength(2);
	});

	it("migrates legacy history before assigning a current-version fork header", () => {
		const source = join(dir, "legacy.jsonl");
		const original = `${[
			{ type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd: dir },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "first", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: { role: "user", content: "second", timestamp: 2 },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(source, original);
		const fork = SessionManager.forkFrom(source, dir, dir);
		expect(
			fork.buildSessionContext().messages.map((message) => ("content" in message ? message.content : undefined)),
		).toEqual(["first", "second"]);
		expect(fork.getBranch()).toHaveLength(2);
		expect(fork.getHeader()?.version).toBe(3);
		expect(readFileSync(source, "utf8")).toBe(original);
		expect(SessionManager.open(fork.getSessionFile()!).getBranch()).toHaveLength(2);
	});
});
