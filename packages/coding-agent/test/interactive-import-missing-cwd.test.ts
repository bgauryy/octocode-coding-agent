import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SessionImportInvalidError } from "../src/core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import { handleImportCommand } from "../src/modes/interactive/interactive-mode/session-commands.ts";

// /import refuses a missing or invalid file before it asks, so the file these imports name is a session header.
const OLD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-import-cwd-")), "old.jsonl");
fs.writeFileSync(
	OLD,
	`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "old", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/gone" })}\n`,
);

function createImportHost(
	importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }>,
) {
	return {
		getPathCommandArgument: () => OLD,
		showConfirmDialog: vi.fn(async () => true),
		promptForMissingSessionCwd: vi.fn(async () => "/tmp/fallback"),
		clearStatusIndicator: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleFatalRuntimeError: vi.fn(async () => undefined as never),
		runtimeHost: { importFromJsonl: vi.fn(importFromJsonl) },
	};
}

const missingCwd = () =>
	new MissingSessionCwdError({ sessionFile: OLD, sessionCwd: "/gone", fallbackCwd: "/tmp/fallback" });

describe("/import into a missing session cwd", () => {
	test("a failed retry in the chosen folder goes through the fatal-error path like the first attempt", async () => {
		const teardown = new Error("session teardown failed");
		const host = createImportHost(async (_path, cwdOverride) => {
			throw cwdOverride ? teardown : missingCwd();
		});

		await handleImportCommand(host as never, `/import ${OLD}`);

		expect(host.runtimeHost.importFromJsonl).toHaveBeenLastCalledWith(OLD, "/tmp/fallback");
		expect(host.handleFatalRuntimeError).toHaveBeenCalledWith("Failed to import session", teardown);
	});

	test("an invalid file found on the retry is an ordinary import error", async () => {
		const host = createImportHost(async (_path, cwdOverride) => {
			throw cwdOverride ? new SessionImportInvalidError(OLD, "bad header") : missingCwd();
		});

		await handleImportCommand(host as never, `/import ${OLD}`);

		expect(host.showError).toHaveBeenCalledWith(expect.stringMatching(/^Failed to import session: /));
		expect(host.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	test("a successful retry reports the import", async () => {
		const host = createImportHost(async (_path, cwdOverride) => {
			if (!cwdOverride) throw missingCwd();
			return { cancelled: false };
		});

		await handleImportCommand(host as never, `/import ${OLD}`);

		expect(host.showStatus).toHaveBeenLastCalledWith(`Session imported from: ${OLD}`);
	});
});
