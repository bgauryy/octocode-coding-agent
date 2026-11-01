import { Container } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import * as agentEvents from "../src/modes/interactive/interactive-mode/agent-events.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const HOSTILE = "go\u001b]0;pwned\u0007 \u001b]8;;https://evil\u001b\\link\u001b]8;;\u001b\\ \u009b2J\u202eend";

function expectClean(output: string): void {
	expect(output).not.toContain("\u001b]");
	expect(output).not.toContain("\u009b");
	expect(output).not.toContain("\u202e");
}

beforeAll(() => initTheme("dark"));

describe("one-line rows drawn from extension and model text", () => {
	test("the working line drops terminal controls from its detail", () => {
		const ui = { requestRender: vi.fn() };
		const indicator = new WorkingStatusIndicator(ui as never, HOSTILE);
		try {
			const output = [...indicator.render(200), indicator.renderInBorder(200)].join("\n");
			expectClean(output);
			expect(output).toContain("go");
			expect(output).toContain("end");
		} finally {
			indicator.dispose();
		}
	});

	test("footer statuses keep their colours and one line but drop other controls", () => {
		const session = {
			state: { model: undefined },
			sessionManager: {
				getEntryCount: () => 0,
				getSessionId: () => "s",
				getLeafId: () => null,
				getEntries: () => [],
				getCwd: () => "/tmp",
				getSessionName: () => undefined,
			},
			getContextUsage: () => undefined,
			modelRuntime: {},
		};
		const footerData = {
			getGitBranch: () => null,
			getExtensionStatuses: () =>
				new Map([
					["a", `${HOSTILE}\nsecond\u2028line`],
					["b", "\u001b[32mgreen\u001b[39m"],
				]),
			getAvailableProviderCount: () => 0,
			onBranchChange: () => () => {},
		};
		const lines = new FooterComponent(session as never, footerData).render(400);
		const status = lines.at(-1) ?? "";
		expectClean(status);
		expect(status).toContain("second line");
		expect(status).toContain("\u001b[32mgreen\u001b[39m");
	});

	test("a failed entry renderer shows its entry type without controls", () => {
		const entry = { type: "custom", customType: HOSTILE, id: "e", parentId: null, timestamp: "" } as CustomEntry;
		const component = new CustomEntryComponent(entry, () => {
			throw new Error("boom");
		});
		const output = component.render(200).join("\n");
		expectClean(output);
		expect(output).toContain("renderer failed: boom");
	});
});

describe("compaction end", () => {
	test("sends the messages held for compaction even when redrawing the compaction fails", async () => {
		const handleEvent = agentEvents.handleEvent as (host: object, event: object) => Promise<void>;
		const host = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			autoCompactionEscapeHandler: undefined,
			defaultEditor: {},
			chatContainer: new Container(),
			sessionManager: { buildContextEntries: () => [] },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const ended = handleEvent(createFakeHost(host), {
			type: "compaction_end",
			reason: "threshold",
			result: { tokensBefore: 1, summary: "s" },
			aborted: false,
			willRetry: true,
		});

		await expect(ended).rejects.toThrow("Completed compaction is missing");
		expect(host.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
	});
});
