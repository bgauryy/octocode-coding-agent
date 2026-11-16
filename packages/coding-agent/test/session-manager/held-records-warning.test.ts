import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { setNoticeHandler } from "../../src/core/session-manager/mirror-writes.ts";
import { lockSessionFile } from "../../src/core/session-manager/shared-file.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

let dir: string;
let session: SessionManager;
let notices: string[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-held-warning-"));
	notices = [];
	setNoticeHandler((message) => notices.push(message));
	session = SessionManager.create(dir, dir);
	session.appendMessage(userMsg("hello"));
	session.appendMessage(assistantMsg("hi"));
});
afterEach(() => {
	setNoticeHandler(undefined);
	rmSync(dir, { recursive: true, force: true });
});

const switches: Record<string, (s: SessionManager) => void> = {
	"a new session": (s) => s.newSession(),
	"a branch": (s) => s.createBranchedSession(s.getLeafId()!),
	"another session file": (s) => {
		const other = SessionManager.create(dir, dir);
		other.appendMessage(userMsg("other"));
		other.appendMessage(assistantMsg("other reply"));
		s.setSessionFile(other.getSessionFile()!);
	},
};

describe("held records dropped on a session switch", () => {
	for (const [name, run] of Object.entries(switches)) {
		it(`warns with the count when ${name} replaces a session holding unsaved records`, () => {
			const release = lockSessionFile(session.getSessionFile()!);
			try {
				session.appendMessage(userMsg("held one"));
				session.appendMessage(assistantMsg("held two"));
				expect(notices).toEqual([]);
				run(session);
			} finally {
				release();
			}
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("2 records");
		});
	}

	it("stays silent when nothing was held", () => {
		session.newSession();
		expect(notices).toEqual([]);
	});
});
