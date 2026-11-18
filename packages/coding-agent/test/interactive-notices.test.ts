import { Container } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { NothingToCompactError } from "../src/core/agent-session/compaction-control.ts";
import * as display from "../src/modes/interactive/interactive-mode/display.ts";
import * as sessionCommands from "../src/modes/interactive/interactive-mode/session-commands.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

beforeAll(() => initTheme("dark"));

describe("/compact", () => {
	function compactHost(compact: () => Promise<unknown>) {
		const fakeThis: any = {
			session: { compact },
			clearStatusIndicator: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		return { fakeThis, host: createFakeHost(fakeThis) };
	}

	test("a session with nothing to compact gets a status line, not an error", async () => {
		const { fakeThis, host } = compactHost(() =>
			Promise.reject(new NothingToCompactError("Nothing to compact (session too small)", "Nothing to compact yet")),
		);

		await sessionCommands.handleCompactCommand(host);

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Nothing to compact yet");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("a real failure stays silent here: it is reported by the compaction_end event", async () => {
		const { fakeThis, host } = compactHost(() => Promise.reject(new Error("provider down")));

		await sessionCommands.handleCompactCommand(host);

		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});

describe("notices", () => {
	const lines = (chatContainer: Container) =>
		chatContainer.children
			.flatMap((child) => child.render(60))
			.map((line) => stripAnsi(line).trimEnd())
			.filter((line) => line !== "");

	test.each([
		["showWarning", display.showWarning, "⚠ 🦀", "Project config not loaded (8 files)."],
		["showError", display.showError, "✗ 🦈", "Compaction failed: model returned no summary"],
	] as const)("%s is one `<glyph> <tone> <sentence>` line at the transcript pad", (_name, show, glyph, message) => {
		const chatContainer = new Container();
		const host = createFakeHost({ chatContainer, outputPad: 1, ui: { requestRender: vi.fn() } } as any);

		show(host, message);

		expect(lines(chatContainer)).toEqual([` ${glyph} ${message}`]);
	});

	test("notices follow the transcript pad setting", () => {
		const chatContainer = new Container();
		const host = createFakeHost({ chatContainer, outputPad: 0, ui: { requestRender: vi.fn() } } as any);

		display.showError(host, "boom");
		chatContainer.addChild(display.noticeLine("success", "New session started", 0));

		expect(lines(chatContainer)).toEqual(["✗ 🦈 boom", "✓ 🐚 New session started"]);
	});

	test("the mark carries the state colour and the words stay readable; an error is red throughout", () => {
		const line = (kind: "success" | "warning" | "error") => display.noticeLine(kind, "x", 0).render(20)[0];

		expect(line("success")).toContain(`${theme.fg("success", "✓ 🐚")} ${theme.fg("text", "x")}`);
		// A long warning is not a wall of amber: only its marks are.
		expect(line("warning")).toContain(`${theme.fg("warning", "⚠ 🦀")} ${theme.fg("text", "x")}`);
		expect(line("error")).toContain(theme.fg("error", "✗ 🦈 x"));
	});

	test("a notice strips terminal controls from its message", () => {
		// Error and warning text often carries tool output (gh stderr, extension errors): it must not drive the terminal.
		const rendered = display
			.noticeLine("error", "gist: \u001b]0;pwned\u0007bad\u001b[2J \u009b31mtoken", 0)
			.render(80)
			.join("\n");

		expect(stripAnsi(rendered).trimEnd()).toBe("✗ 🦈 gist: bad token");
		expect(rendered.replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});
});
