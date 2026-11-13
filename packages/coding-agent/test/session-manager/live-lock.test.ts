import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { lockSessionFile, withSessionFileLock } from "../../src/core/session-manager/shared-file.ts";

let dir: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

it("does not take over a recorded live session writer after the heartbeat becomes stale", () => {
	dir = mkdtempSync(join(tmpdir(), "session-live-lock-"));
	const file = join(dir, "session.jsonl");
	const release = lockSessionFile(file);
	try {
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		expect(() => withSessionFileLock(file, () => "stolen", 0)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
	} finally {
		release();
	}
	expect(readdirSync(dir)).toEqual([]);
});
