import type { TextContent } from "@octocodeai/octocode-ai";
import { type Component, Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { MessageRenderer } from "../../../core/features/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
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

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

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
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

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
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();
		this.box.setPaddingX(this.outputPad);

		// Default rendering: label + content
		const label = theme.fg(
			"customMessageLabel",
			theme.bold(
				`[${sanitizeTerminalText(this.message.customType)}]${this.rendererFailed ? " Renderer failed; showing message." : ""}`,
			),
		);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(sanitizeTerminalText(text), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
