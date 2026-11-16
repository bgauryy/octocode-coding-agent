import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RunnerStatus from "../src/octocode/external/runner-status.ts";

const external = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock("../src/modes/interactive/external-editor.ts", () => ({ editInExternalEditor: external.edit }));
vi.mock("@octocodeai/octocode-common/find-on-path", () => ({ findOnPath: () => "/usr/local/bin/vendor-cli" }));
vi.mock("../src/octocode/external/runner-status.ts", async (original) => ({
	...(await original<typeof RunnerStatus>()),
	checkRunners: async () => [],
}));
const page = vi.hoisted(() => ({ choice: "" }));
vi.mock("../src/modes/interactive/interactive-mode/provider-ui.ts", () => ({
	showPage: async () => ({ id: page.choice }),
}));

import { setupKeyHandlers } from "../src/modes/interactive/interactive-mode/input-handlers.ts";
import { showRunnerDetail } from "../src/modes/interactive/interactive-mode/provider-runners.ts";
import { runnerSpec } from "../src/octocode/external/runners.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

/** A UI whose stop queued restore output: `drainOutput` settles only when the test says it reached the terminal. */
function drainingUi() {
	const order: string[] = [];
	let drained!: () => void;
	const ui = {
		stop: vi.fn(() => order.push("stop")),
		start: vi.fn(),
		requestRender: vi.fn(),
		terminal: {
			drainOutput: () =>
				new Promise<boolean>((resolve) => {
					order.push("drain");
					drained = () => {
						order.push("drained");
						resolve(true);
					};
				}),
		},
	};
	return { ui, order, drained: () => drained() };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("handing the terminal to a child", () => {
	afterEach(() => vi.clearAllMocks());

	it("starts the external editor only after the restore output reached the terminal", async () => {
		const { ui, order, drained } = drainingUi();
		external.edit.mockImplementation(async () => {
			order.push("spawn");
			return { status: "complete", content: "edited" };
		});
		const actionHandlers = new Map<string, () => void>();
		let text = "draft";
		const editor = {
			actionHandlers,
			onAction: (action: string, handler: () => void) => actionHandlers.set(action, handler),
			getText: () => text,
			setText: (next: string) => {
				text = next;
			},
			addToHistory: vi.fn(),
		};
		const host = createFakeHost({
			defaultEditor: editor,
			editor,
			ui,
			settingsManager: { getExternalEditorCommand: () => "true" },
		});
		setupKeyHandlers(host);

		actionHandlers.get("app.editor.external")?.();
		await turn();
		expect(order).toEqual(["stop", "drain"]);
		drained();
		await turn();
		expect(order).toEqual(["stop", "drain", "drained", "spawn"]);
		expect(text).toBe("edited");
	});

	it("runs a vendor sign-in only after the restore output reached the terminal", async () => {
		const spec = runnerSpec("codex")!;
		page.choice = `Sign in with ${spec.name}'s own login (${[spec.cli, ...spec.login].join(" ")})`;
		const { ui, order, drained } = drainingUi();
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			order.push("write");
			return true;
		});
		const run = vi.fn(async () => {
			order.push("spawn");
			return { code: 0 };
		});
		const state = { id: "codex", cli: true, adapter: true, checkedAt: 1 } as unknown as RunnerStatus.RunnerState;
		const host = {
			ui,
			session: {
				settingsManager: {
					getExternalAgents: () => false,
					getEnabledExternalAgents: () => undefined,
					setExternalAgents: vi.fn(),
				},
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: vi.fn(),
		};
		try {
			const done = showRunnerDetail(host as never, "codex", [state], { run });
			await turn();
			expect(order).toEqual(["stop", "drain"]);
			drained();
			await done;
			expect(order.slice(0, 5)).toEqual(["stop", "drain", "drained", "write", "spawn"]);
		} finally {
			write.mockRestore();
		}
	});
});
