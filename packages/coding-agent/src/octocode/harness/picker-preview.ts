import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { Theme } from "../../theme/theme.ts";
import { shortcutText } from "../shared/keys.ts";

/**
 * The page the list shows before an external source switches on: the scanned items it would bring, worst first.
 * Enter switches it on; Esc leaves everything as it was.
 */
export class SwitchOnPreview {
	readonly title: string;
	private readonly lines: readonly string[];
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	constructor(title: string, lines: readonly string[], theme: Theme, keys: KeybindingsManager) {
		this.title = title;
		this.lines = lines;
		this.theme = theme;
		this.keys = keys;
	}

	/** `confirm` switches on, `cancel` writes nothing; undefined: the key is not for this page. */
	handleInput(data: string): "confirm" | "cancel" | undefined {
		if (this.keys.matches(data, "tui.select.cancel")) return "cancel";
		return this.keys.matches(data, "tui.select.confirm") ? "confirm" : undefined;
	}

	render(width: number, height: number): string[] {
		const t = this.theme;
		const out: string[] = [` ${t.fg("accent", t.bold(this.title))}`];
		for (const line of this.lines)
			for (const wrapped of wrapTextWithAnsi(sanitizeTerminalText(line), width - 2)) out.push(` ${wrapped}`);
		const shown = out.slice(0, Math.max(1, height - 1));
		shown.push(
			t.fg("muted", ` Enter turn on · ${shortcutText("tui.select.cancel", this.keys)} cancel (nothing is written)`),
		);
		return shown.map((line) => truncateToWidth(line, width, "…"));
	}
}
