import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleExportCommand, handleShareCommand } from "../src/modes/interactive/interactive-mode/session-commands.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

/** A host whose session file is `file`: written once the first reply arrives, absent before. */
function host(file: string | undefined) {
	return createFakeHost({
		sessionManager: { getSessionFile: () => file },
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showConfirmDialog: vi.fn(async () => false),
		getPathCommandArgument: () => undefined,
	});
}

const unwritten = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-empty-")), "session.jsonl");

describe("session commands before the first message", () => {
	it("/export says there is nothing to export yet, as a warning and not an export failure", async () => {
		const h = host(unwritten());
		await handleExportCommand(h, "/export");
		expect(h.showWarning).toHaveBeenCalledWith("Nothing to export yet: send a message first.");
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("/share says there is nothing to share before it asks to upload", async () => {
		const h = host(unwritten());
		await handleShareCommand(h);
		expect(h.showWarning).toHaveBeenCalledWith("Nothing to share yet: send a message first.");
		expect(h.showConfirmDialog).not.toHaveBeenCalled();
	});

	it("/share still asks once the session is saved, and a decline uploads nothing", async () => {
		const file = unwritten();
		fs.writeFileSync(file, "");
		const h = host(file);
		await handleShareCommand(h);
		expect(h.showConfirmDialog).toHaveBeenCalledWith("Share session", expect.stringContaining("secret GitHub gist"));
		expect(h.showStatus).toHaveBeenCalledWith("Share cancelled");
		expect(h.showWarning).not.toHaveBeenCalled();
	});
});
