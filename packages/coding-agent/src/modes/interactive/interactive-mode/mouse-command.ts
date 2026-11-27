import { TuiAltScreen } from "@octocodeai/octocode-tui";

/**
 * `/mouse` toggles fullscreen mouse capture and `/mouse on|off` sets it, for terminals where the toggle key
 * (`tui.altScreen.toggleMouse`) cannot be typed. The screen's notice says what the mouse does now.
 */
export function mouseCommand(host: { readonly ui: unknown; showWarning(message: string): void }, args: string): void {
	if (args !== "" && args !== "on" && args !== "off") {
		host.showWarning("Usage: /mouse [on|off]");
		return;
	}
	if (!(host.ui instanceof TuiAltScreen)) {
		host.showWarning("/mouse changes nothing in regular mode: the terminal already owns the mouse.");
		return;
	}
	host.ui.setMouseCapture(args === "" ? undefined : args === "on");
}
