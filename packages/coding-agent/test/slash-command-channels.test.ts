import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	handleClearCommand,
	handleImportCommand,
	handleNameCommand,
} from "../src/modes/interactive/interactive-mode/session-commands.ts";
import { SessionNameError } from "../src/core/agent-session-runtime/import.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

function host(extra: Record<string, unknown> = {}) {
	return {
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		getPathCommandArgument: () => undefined,
		sessionManager: { getSessionName: () => undefined, getSessionFile: () => undefined },
		clearStatusIndicator: vi.fn(),
		ui: { requestRender: vi.fn() },
		...extra,
	};
}

describe("usage messages use one channel (a warning; errors are for failures)", () => {
	test("/import without a path", async () => {
		const h = host();
		await handleImportCommand(h as never, "/import");
		expect(h.showWarning).toHaveBeenCalledWith("Usage: /import <path.jsonl>");
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("/rename without a name", () => {
		const h = host();
		handleNameCommand(h as never, "/name");
		expect(h.showWarning).toHaveBeenCalledWith("Usage: /rename <name>");
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("/new with a bad name", async () => {
		const h = host({
			runtimeHost: {
				newSession: async () => {
					throw new SessionNameError();
				},
			},
		});
		await handleClearCommand(h as never, " ");
		expect(h.showWarning).toHaveBeenCalledWith(expect.stringContaining("Usage: /new [name-for-the-current-session]"));
		expect(h.showError).not.toHaveBeenCalled();
	});
});

/** The chat lines a command added, as text. */
const chatText = (h: { chatContainer: { addChild: ReturnType<typeof vi.fn> } }) =>
	h.chatContainer.addChild.mock.calls.map(([child]) => child.render?.(200)?.join("\n") ?? "").join("\n");

describe("a session with no message is not saved, and its name says so", () => {
	beforeAll(() => initTheme("dark"));
	const unsavedHost = (written: boolean) => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-unsaved-")), "session.jsonl");
		if (written) fs.writeFileSync(file, "");
		let name: string | undefined;
		return host({
			chatContainer: { addChild: vi.fn() },
			uiStore: createUiStore({ view: { outputPad: 0 } }),
			session: { setSessionName: (next: string) => (name = next) },
			sessionManager: { getSessionFile: () => file, getSessionName: () => name },
			runtimeHost: { newSession: vi.fn(async () => ({ cancelled: false })) },
		});
	};

	test("/rename before the first message says the name is kept once a message is sent", () => {
		const h = unsavedHost(false);
		handleNameCommand(h as never, "/name my-session");
		expect(chatText(h as never)).toContain("Session name set: my-session · kept once the session has a message");
		const saved = unsavedHost(true);
		handleNameCommand(saved as never, "/name my-session");
		expect(chatText(saved as never)).not.toContain("kept once");
	});

	test("/new after a name on an empty session says the name was not saved; a saved one says nothing", async () => {
		const renamed = unsavedHost(false);
		handleNameCommand(renamed as never, "/name my-session");
		await handleClearCommand(renamed as never);
		expect(chatText(renamed as never)).toContain(
			'New session started · the previous one had no messages, so "my-session" was not saved',
		);
		const named = unsavedHost(false);
		await handleClearCommand(named as never, "old-work");
		expect(chatText(named as never)).toContain('so "old-work" was not saved');
		const saved = unsavedHost(true);
		await handleClearCommand(saved as never, "old-work");
		expect(chatText(saved as never)).toContain("New session started");
		expect(chatText(saved as never)).not.toContain("not saved");
	});
});
