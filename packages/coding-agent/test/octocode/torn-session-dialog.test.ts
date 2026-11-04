import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { offerForkOfTornSession } from "../../src/modes/interactive/interactive-mode/session-navigation.ts";

describe("the offer to fork a session with a torn tail", () => {
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
	const hostFor = (manager: SessionManager, answer: boolean) => ({
		sessionManager: manager,
		showExtensionConfirm: vi.fn(async (_title: string, _message: string) => answer),
		handleResumeSession: vi.fn(async (_path: string) => ({ cancelled: false })),
		showWarning: vi.fn((_message: string) => undefined),
		showError: vi.fn((_message: string) => undefined),
	});

	it("says nothing about a whole session", async () => {
		const { manager, file } = session(false);
		const host = hostFor(manager, true);
		await offerForkOfTornSession(host, file);
		expect(host.showExtensionConfirm).not.toHaveBeenCalled();
	});

	it("forks on yes and resumes the fork, leaving the file byte-identical", async () => {
		const { manager, file } = session(true);
		const bytes = readFileSync(file);
		const host = hostFor(manager, true);
		await offerForkOfTornSession(host, file);
		expect(host.handleResumeSession).toHaveBeenCalledTimes(1);
		const [forked] = host.handleResumeSession.mock.calls[0];
		expect(forked).not.toBe(file);
		expect(SessionManager.open(forked, dir).buildSessionContext().messages).toHaveLength(1);
		expect(readFileSync(file).equals(bytes)).toBe(true);
	});

	it("on no, warns that the session stays read-only and changes nothing", async () => {
		const { manager, file } = session(true);
		const bytes = readFileSync(file);
		const host = hostFor(manager, false);
		await offerForkOfTornSession(host, file);
		expect(host.handleResumeSession).not.toHaveBeenCalled();
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("read-only"));
		expect(readFileSync(file).equals(bytes)).toBe(true);
	});
});
