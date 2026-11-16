import { Container, TuiMainScreen } from "@octocodeai/octocode-tui";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

class ProcessExit extends Error {}

describe("signal shutdown restores the terminal before it disposes", () => {
	afterEach(() => vi.restoreAllMocks());

	async function signalShutdown(stop: (order: readonly string[]) => void) {
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ProcessExit();
		});
		const order: string[] = [];
		const host = {
			isShuttingDown: false,
			unregisterSignalHandlers: vi.fn(),
			runtimeHost: { dispose: vi.fn(async () => void order.push("dispose")) },
			ui: {
				terminal: {
					drainInput: vi.fn(async () => void order.push("drainInput")),
					drainOutput: vi.fn(async () => {
						order.push("drainOutput");
						return true;
					}),
				},
			},
			themeController: { disableAutoSync: vi.fn() },
			stop: vi.fn(() => {
				order.push("stop");
				stop(order);
			}),
			sessionManager: {},
		};
		await lifecycle.shutdown(createFakeHost(host), { fromSignal: true }).catch((error: unknown) => {
			if (!(error instanceof ProcessExit)) throw error;
		});
		return { order, host };
	}

	test("dispose runs before the terminal is touched, then the terminal stops and drains before exit", async () => {
		const { order, host } = await signalShutdown(() => {});
		expect(order).toEqual(["dispose", "drainInput", "stop", "drainOutput"]);
		expect(process.exit).toHaveBeenCalledWith(0);
		expect(host.runtimeHost.dispose).toHaveBeenCalledOnce();
	});

	test("a terminal that fails while stopping cannot skip the extension teardown", async () => {
		const seen: string[] = [];
		await expect(
			signalShutdown((order) => {
				seen.push(...order);
				throw Object.assign(new Error("EIO"), { code: "EIO" });
			}),
		).rejects.toThrow("EIO");
		expect(seen).toEqual(["dispose", "drainInput", "stop"]);
	});
});

describe("idle editor prompt marks", () => {
	function frame(markPrompt: () => boolean): string[] {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, defaultEditorTheme, KeybindingsManager.create(), { markPrompt });
		const root = new Container();
		root.addChild({ render: () => ["\x1b]133;A\x07message\x1b]133;B\x07\x1b]133;C\x07"], invalidate() {} });
		root.addChild(editor);
		return root.render(40);
	}
	const lastMark = (rows: string[]) => [...rows.join("\n").matchAll(/\x1b\]133;([ABCD])/g)].at(-1)?.[1];

	test("idle in regular mode, the last frame ends in prompt state", () => {
		expect(lastMark(frame(() => true))).toBe("B");
	});

	test("otherwise the last mark stays the message's output mark", () => {
		expect(lastMark(frame(() => false))).toBe("C");
	});
});
