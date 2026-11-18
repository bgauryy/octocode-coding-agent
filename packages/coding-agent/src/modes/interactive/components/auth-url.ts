import {
	type Component,
	Container,
	hyperlink,
	SEPARATOR,
	Text,
	truncateToWidth,
	type TUI,
} from "@octocodeai/octocode-tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { theme } from "../../../theme/theme.ts";
import { keyHint } from "../../../theme/theme-tui-helpers.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** One hint line, indent 1, cut with `…` at the width: hint lines never wrap. */
class HintText implements Component {
	text = "";
	invalidate(): void {}
	render(width: number): string[] {
		return [truncateToWidth(` ${this.text}`, width, "…")];
	}
}

/**
 * A sign-in URL with a click hint and a copy hint. Hosts call `copy()` when `app.message.copy` is
 * pressed, since a long URL wraps and often cannot be selected or clicked as a whole (SSH, tmux).
 */
export class AuthUrlComponent extends Container {
	readonly url: string;
	private readonly tui: TUI;
	private readonly hint = new HintText();

	constructor(tui: TUI, url: string) {
		super();
		this.tui = tui;
		this.url = url;
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		this.addChild(this.hint);
		this.setHint(keyHint("app.message.copy", "copy"));
	}

	private setHint(suffix: string): void {
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.hint.text = `${theme.fg("dim", hyperlink(clickHint, this.url))}${theme.fg("dim", SEPARATOR)}${suffix}`;
		this.tui.requestRender();
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			this.setHint(theme.fg("success", "Copied URL to clipboard"));
		} catch (error) {
			this.setHint(theme.fg("error", errorMessage(error)));
		}
	}
}
