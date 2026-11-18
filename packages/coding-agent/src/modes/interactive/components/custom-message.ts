import type { TextContent } from "@octocodeai/octocode-ai";
import {
	type Component,
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	trackRenderChanges,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { MessageRenderer } from "../../../core/features/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";

/**
 * Component that renders a custom message entry from features.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private rendererFailed = false;

	constructor(
		message: CustomMessage,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		// The default rendering's band: no vertical padding; the blank row above it is a plain spacer.
		this.box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	override render(width: number): string[] {
		try {
			return super.render(width);
		} catch {
			this.customRenderer = undefined;
			this.rendererFailed = true;
			this.rebuild();
			return super.render(width);
		}
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					this.customComponent = component;
					// One blank row above, as on the default rendering.
					this.addChild(new Spacer(1));
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering: one blank row above the box, none below, so stacked blocks keep one blank row between them.
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.box.clear();
		this.box.setPaddingX(this.outputPad);

		// Default rendering: `[label] body` on one row when the body is one line, else the label row and the body under it.
		const label = theme.fg("customMessageLabel", theme.bold(`[${sanitizeTerminalText(this.message.customType)}]`));
		const text =
			typeof this.message.content === "string"
				? this.message.content
				: this.message.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		const body = sanitizeTerminalText(text).trim();
		const oneLine = !this.rendererFailed && body !== "" && !body.includes("\n");
		this.box.addChild(new Text(oneLine ? `${label} ${this.inlineMarkdown(body)}` : label, 0, 0));
		if (oneLine) return;
		if (this.rendererFailed)
			this.box.addChild(
				new Text(
					theme.fg(
						"dim",
						`The ${sanitizeTerminalText(this.message.customType)} renderer failed; showing the message as text.`,
					),
					0,
					0,
				),
			);
		this.box.addChild(this.markdown(body));
	}

	private markdown(body: string): Markdown {
		return new Markdown(body, 0, 0, this.markdownTheme, {
			color: (text: string) => theme.fg("customMessageText", text),
		});
	}

	/**
	 * A one-line body styled as Markdown, as one unwrapped row: the label row then wraps it whole. It is drawn wider than
	 * its source, which Markdown only shortens, and the row's width padding is dropped.
	 */
	private inlineMarkdown(body: string): string {
		const rows = this.markdown(body).render(visibleWidth(body) * 2 + 16);
		return rows
			.map((row) => row.replace(/ +$/, ""))
			.filter((row) => row !== "")
			.join(" ");
	}
}

// Every state change rebuilds the children, and the container signals each edit.
trackRenderChanges(CustomMessageComponent.prototype);
