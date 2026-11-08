import { describe, expect, test, vi } from "vitest";
import {
	handleClearCommand,
	handleImportCommand,
	handleNameCommand,
} from "../src/modes/interactive/interactive-mode/session-commands.ts";
import { SessionNameError } from "../src/core/agent-session-runtime/import.ts";

function host(extra: Record<string, unknown> = {}) {
	return {
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		getPathCommandArgument: () => undefined,
		sessionManager: { getSessionName: () => undefined },
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
