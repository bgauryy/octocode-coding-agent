import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

describe("a branch whose file cannot be written", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-branch-fail-"));
	});
	afterEach(() => {
		chmodSync(dir, 0o755);
		rmSync(dir, { recursive: true, force: true });
	});

	it("is created whole, with its header and every entry, by the next write", () => {
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendMessage(user("first"));
		manager.appendMessage(user("second"));
		chmodSync(dir, 0o555);
		expect(() => manager.createBranchedSession(first)).toThrow();
		chmodSync(dir, 0o755);

		manager.appendMessage(user("third"));
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(lines.join("\n")).toContain("first");
		expect(lines.join("\n")).toContain("third");
	});
});
