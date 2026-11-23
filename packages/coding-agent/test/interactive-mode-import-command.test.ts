import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import {
	getPathCommandArgument,
	handleImportCommand,
} from "../src/modes/interactive/interactive-mode/session-commands.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type PathCommand = "/export" | "/import";

type ImportCommandContext = {
	clearStatusIndicator: () => void;
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showConfirmDialog: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

/** A session header line: /import checks the file is a session before it asks, so a stand-in needs one. */
const HEADER = `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "imported", timestamp: "2026-01-01T00:00:00.000Z", cwd: os.tmpdir() })}\n`;

/** A session file at `relative` under a fresh folder: /import refuses a missing or invalid file before it asks. */
function sessionFile(relative: string, content = HEADER): string {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-import-")), relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe("path/to/session.jsonl");
		expect(getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import")).toBe(
			"path with spaces/session.jsonl",
		);
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe("john's/session.jsonl");
	});

	it("enforces command token boundaries", () => {
		expect(getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(undefined);
		expect(getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe("/tmp/session.jsonl");
	});

	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showConfirmDialog = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showConfirmDialog,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument,
		};

		const file = sessionFile("path with spaces/session.jsonl");
		await handleImportCommand(createFakeHost(context), `/import "${file}"`);

		expect(showConfirmDialog).toHaveBeenCalledWith("Import session", `Replace current session with ${file}?`);
		expect(importFromJsonl).toHaveBeenCalledWith(file);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Session imported from: ${file}`);
	});

	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showConfirmDialog = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showConfirmDialog,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument,
		};

		const file = sessionFile("john's/session.jsonl");
		await handleImportCommand(createFakeHost(context), `/import ${file}`);

		expect(importFromJsonl).toHaveBeenCalledWith(file);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Session imported from: ${file}`);
	});

	it("refuses a missing file before asking to replace the session", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showConfirmDialog = vi.fn(async () => true);
		const showWarning = vi.fn();
		const host = createFakeHost({
			runtimeHost: { importFromJsonl },
			showConfirmDialog,
			showWarning,
			getPathCommandArgument,
		});
		const missing = path.join(os.tmpdir(), "octocode-import-none", "missing.jsonl");

		await handleImportCommand(host, `/import ${missing}`);

		expect(showWarning).toHaveBeenCalledWith(`Not imported: ${missing} does not exist.`);
		expect(showConfirmDialog).not.toHaveBeenCalled();
		expect(importFromJsonl).not.toHaveBeenCalled();
	});

	it.each([
		['not json\n{"broken":\n', "line 1 is not JSON"],
		["\n" + JSON.stringify({ type: "message", id: "m1" }) + "\n", 'line 2 is a "message" record'],
		["", "it is empty"],
	])("refuses a file that is not a session before asking, naming the file and its first line", async (content, why) => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showConfirmDialog = vi.fn(async () => true);
		const showWarning = vi.fn();
		const host = createFakeHost({
			runtimeHost: { importFromJsonl },
			showConfirmDialog,
			showWarning,
			getPathCommandArgument,
		});
		const file = sessionFile("garbage.jsonl", content);

		await handleImportCommand(host, `/import ${file}`);

		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining(`Not imported: ${file} is not a session file: ${why}`),
		);
		expect(showConfirmDialog).not.toHaveBeenCalled();
		expect(importFromJsonl).not.toHaveBeenCalled();
	});

	it("shows a non-fatal error when the file is gone by the time the import runs", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showConfirmDialog = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showConfirmDialog,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument,
		};

		await handleImportCommand(createFakeHost(context), `/import ${sessionFile("gone.jsonl")}`);

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
