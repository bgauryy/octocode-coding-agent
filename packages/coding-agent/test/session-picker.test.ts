import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { selectSession } from "../src/cli/session-picker.ts";
import type * as Liveness from "../src/octocode/agentdb/liveness.ts";

const { confirm, livePid, selectors, ui } = vi.hoisted(() => ({
	confirm: vi.fn(),
	livePid: vi.fn(),
	selectors: [] as unknown[][],
	ui: { stop: vi.fn(), addChild: vi.fn(), setFocus: vi.fn(), requestRender: vi.fn() },
}));
vi.mock("../src/octocode/agentdb/liveness.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Liveness>()),
	sessionFileRunningPid: livePid,
}));
vi.mock("../src/cli/startup-ui.ts", () => ({
	createStartupTui: async () => ui,
	startStartupTui: vi.fn(),
	showStartupSelector: confirm,
}));
vi.mock("../src/modes/interactive/components/session-selector.ts", () => ({
	SessionSelectorComponent: class {
		constructor(...args: unknown[]) {
			selectors.push(args);
		}
		getSessionList() {
			return {};
		}
	},
}));

async function select(path: string): Promise<string | null> {
	const pending = selectSession(
		async () => [],
		async () => [],
		{} as SettingsManager,
	);
	await vi.waitFor(() => expect(selectors.length).toBeGreaterThan(0));
	const onSelect = selectors.at(-1)?.[2] as (path: string) => Promise<void>;
	await onSelect(path);
	return pending;
}

describe("startup session picker", () => {
	beforeEach(() => {
		confirm.mockReset();
		livePid.mockReset();
		selectors.length = 0;
		for (const method of Object.values(ui)) method.mockClear();
	});

	it("returns a non-live selection without prompting", async () => {
		livePid.mockReturnValue(undefined);
		await expect(select("/tmp/other.jsonl")).resolves.toBe("/tmp/other.jsonl");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("returns a live selection after confirmation", async () => {
		livePid.mockReturnValue(42);
		confirm.mockResolvedValue(true);
		await expect(select("/tmp/other.jsonl")).resolves.toBe("/tmp/other.jsonl");
		expect(confirm).toHaveBeenCalledOnce();
		expect(ui.stop).toHaveBeenCalled();
	});

	it("does not return a live selection when confirmation is rejected", async () => {
		livePid.mockReturnValue(42);
		confirm.mockResolvedValue(false);
		await expect(select("/tmp/other.jsonl")).resolves.toBeNull();
		expect(confirm).toHaveBeenCalledOnce();
	});
});
