import { Container, Markdown, type MarkdownTheme } from "@octocodeai/octocode-tui";
import type { ApplicationMessage } from "@octocodeai/octocode-contacts";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import {
	ContentAttachmentComponent,
	contentText,
	FullContentReader,
	type ContentOptions,
} from "./application-content.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private message: ApplicationMessage;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private contentOptions: ContentOptions;

	constructor(
		text: string | ApplicationMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		contentOptions: ContentOptions = {},
	) {
		super();
		this.message = typeof text === "string" ? { id: "user", role: "user", text, complete: true } : text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.contentOptions = contentOptions;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setShowImages(showImages: boolean): void {
		this.contentOptions = { ...this.contentOptions, showImages };
		this.rebuild();
	}

	setImageWidthCells(imageWidthCells: number): void {
		this.contentOptions = { ...this.contentOptions, imageWidthCells };
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.message = new FullContentReader().message(this.message, this.contentOptions.readAsset);
		const content = this.message.content ?? [
			{ id: `${this.message.id}:text`, type: "text" as const, text: this.message.text },
		];
		for (const block of content) {
			if (block.type !== "text") {
				this.addChild(new ContentAttachmentComponent(block, this.contentOptions));
				continue;
			}
			// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
			// line, with identical output.
			this.addChild(
				new Markdown(
					contentText(block, this.contentOptions.readAsset),
					this.outputPad,
					1,
					this.markdownTheme,
					{
						color: (content: string) => theme.fg("userMessageText", content),
						bgColor: (content: string) => theme.bg("userMessageBg", content),
					},
					{
						preserveOrderedListMarkers: true,
						preserveBackslashEscapes: true,
						transform: createMarkdownTransform("user", false, this.markdownTransformers),
					},
				),
			);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
