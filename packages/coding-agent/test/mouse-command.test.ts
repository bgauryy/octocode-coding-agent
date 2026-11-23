import { TuiAltScreen } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { mouseCommand } from "../src/modes/interactive/interactive-mode/mouse-command.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

function fullscreen() {
	const ui = new TuiAltScreen(new VirtualTerminal(80, 10));
	const flashes: string[] = [];
	vi.spyOn(ui, "flash").mockImplementation((message) => void flashes.push(message));
	const warnings: string[] = [];
	return { host: { ui, showWarning: (message: string) => void warnings.push(message) }, flashes, warnings };
}

describe("/mouse", () => {
	it("toggles bare, sets with on or off, and always says what the mouse does now", () => {
		const { host, flashes, warnings } = fullscreen();
		host.ui.start();
		mouseCommand(host, "");
		mouseCommand(host, "on");
		mouseCommand(host, "on");
		mouseCommand(host, "off");
		expect(flashes.map((message) => message.split(":")[0])).toEqual(["Mouse off", "Mouse on", "Mouse on", "Mouse off"]);
		expect(warnings).toEqual([]);
		host.ui.stop();
	});

	it("says why it does nothing outside fullscreen, and how to use it", () => {
		const warnings: string[] = [];
		const host = { ui: {}, showWarning: (message: string) => void warnings.push(message) };
		mouseCommand(host, "");
		mouseCommand({ ui: fullscreen().host.ui, showWarning: host.showWarning }, "maybe");
		expect(warnings).toEqual([
			"/mouse changes nothing in regular mode: the terminal already owns the mouse.",
			"Usage: /mouse [on|off]",
		]);
	});
});
