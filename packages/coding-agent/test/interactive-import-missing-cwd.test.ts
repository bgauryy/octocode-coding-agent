import { describe, expect, test, vi } from "vitest";
import { SessionImportInvalidError } from "../src/core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { handleImportCommand } from "../src/modes/interactive/interactive-mode/session-commands.ts";

function createImportHost(
	importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }>,
) {
	return {
		getPathCommandArgument: () => "/tmp/old.jsonl",
		showExtensionConfirm: vi.fn(async () => true),
		promptForMissingSessionCwd: vi.fn(async () => "/tmp/fallback"),
		clearStatusIndicator: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleFatalRuntimeError: vi.fn(async () => undefined as never),
		runtimeHost: { importFromJsonl: vi.fn(importFromJsonl) },
	};
}

const missingCwd = () =>
	new MissingSessionCwdError({ sessionFile: "/tmp/old.jsonl", sessionCwd: "/gone", fallbackCwd: "/tmp/fallback" });

describe("/import into a missing session cwd", () => {
	test("a failed retry in the chosen folder goes through the fatal-error path like the first attempt", async () => {
		const teardown = new Error("session teardown failed");
		const host = createImportHost(async (_path, cwdOverride) => {
			throw cwdOverride ? teardown : missingCwd();
		});

		await handleImportCommand(host as never, "/import /tmp/old.jsonl");

		expect(host.runtimeHost.importFromJsonl).toHaveBeenLastCalledWith("/tmp/old.jsonl", "/tmp/fallback");
		expect(host.handleFatalRuntimeError).toHaveBeenCalledWith("Failed to import session", teardown);
	});

	test("an invalid file found on the retry is an ordinary import error", async () => {
		const host = createImportHost(async (_path, cwdOverride) => {
			throw cwdOverride ? new SessionImportInvalidError("/tmp/old.jsonl", "bad header") : missingCwd();
		});

		await handleImportCommand(host as never, "/import /tmp/old.jsonl");

		expect(host.showError).toHaveBeenCalledWith(expect.stringMatching(/^Failed to import session: /));
		expect(host.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	test("a successful retry reports the import", async () => {
		const host = createImportHost(async (_path, cwdOverride) => {
			if (!cwdOverride) throw missingCwd();
			return { cancelled: false };
		});

		await handleImportCommand(host as never, "/import /tmp/old.jsonl");

		expect(host.showStatus).toHaveBeenLastCalledWith("Session imported from: /tmp/old.jsonl");
	});
});
