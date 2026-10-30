import { getKeybindings, Markdown, matchesKey, Text, type Component } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../octocode/shared/sanitize.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** Scrollable read-only overlay that does not append content to the conversation. */
export class CommandReport implements Component {
	private offset = 0;
	private length = 0;
	private height = 16;
	private unsubscribe?: () => void;
	private readonly title: string;
	private readonly text: () => string;
	private readonly close: () => void;
	private readonly renderRequest: () => void;
	private readonly cancel?: () => void;
	constructor(
		title: string,
		text: () => string,
		close: () => void,
		renderRequest: () => void,
		cancel?: () => void,
		subscribe?: (listener: () => void) => () => void,
	) {
		this.title = title;
		this.text = text;
		this.close = close;
		this.renderRequest = renderRequest;
		this.cancel = cancel;
		this.unsubscribe = subscribe?.(() => this.renderRequest());
	}
	invalidate(): void {}
	dispose(): void {
		this.unsubscribe?.();
	}
	render(width: number): string[] {
		const body = new Markdown(sanitizeTerminalText(this.text()), 1, 0, getMarkdownTheme()).render(width);
		this.length = body.length;
		this.height = Math.max(1, Math.min(16, (process.stdout.rows ?? 24) - 6));
		this.offset = Math.min(this.offset, Math.max(0, body.length - this.height));
		return [
			...new Text(theme.bold(this.title), 1, 0).render(width),
			...body.slice(this.offset, this.offset + this.height),
			...new Text(
				[
					keyHint("tui.select.up", "/") + keyHint("tui.select.down", "scroll"),
					keyHint("tui.select.pageDown", "page"),
					keyHint("tui.select.cancel", "or Enter close"),
					...(this.cancel ? [rawKeyHint("ctrl+c", "cancel side request")] : []),
				].join(theme.fg("muted", " · ")),
				1,
				0,
			).render(width),
		];
	}
	handleInput(data: string): void {
		const keys = getKeybindings();
		const last = Math.max(0, this.length - this.height);
		if (matchesKey(data, "ctrl+c") && this.cancel) this.cancel();
		else if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) this.close();
		else if (keys.matches(data, "tui.select.up")) this.offset = Math.max(0, this.offset - 1);
		else if (keys.matches(data, "tui.select.down")) this.offset = Math.min(last, this.offset + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.height);
		else if (keys.matches(data, "tui.select.pageDown")) this.offset = Math.min(last, this.offset + this.height);
		this.renderRequest();
	}
}
