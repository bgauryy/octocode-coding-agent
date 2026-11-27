import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { offerForkOfTornSession } from "../../src/modes/interactive/interactive-mode/session-navigation.ts";

describe("the notice for a session opened with a torn tail", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-torn-dialog-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function session(torn: boolean) {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const file = manager.getSessionFile()!;
		if (torn) appendFileSync(file, '{"type":"message","id":"to');
		return { manager, file };
	}
	const hostFor = () => ({ showWarning: vi.fn((_message: string) => undefined) });

	it("says nothing about a whole session", async () => {
		const { file } = session(false);
		const host = hostFor();
		await offerForkOfTornSession(host, file);
		expect(host.showWarning).not.toHaveBeenCalled();
	});

	it("warns once that the cut-off record is skipped, changes nothing, and the session goes on", async () => {
		const { file } = session(true);
		const bytes = readFileSync(file);
		const host = hostFor();
		await offerForkOfTornSession(host, file);
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("cut off"));
		expect(readFileSync(file).equals(bytes)).toBe(true);
		const reopened = SessionManager.open(file, dir);
		reopened.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await offerForkOfTornSession(host, file);
		expect(host.showWarning).toHaveBeenCalledTimes(1);
	});
});
