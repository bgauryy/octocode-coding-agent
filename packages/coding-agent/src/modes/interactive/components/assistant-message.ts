import type { AssistantMessage } from "@octocodeai/octocode-ai";
import type { ApplicationMessage } from "@octocodeai/octocode-contacts";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@octocodeai/octocode-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { sanitizeTerminalText } from "../../../octocode/shared/sanitize.ts";
import { ApplicationAssets } from "../../../core/application/assets.ts";
import { normalizeApplicationMessage } from "../../../core/application/normalize.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import {
	ContentAttachmentComponent,
	contentText,
	FullContentReader,
	type ContentOptions,
} from "./application-content.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private contentOptions: ContentOptions;
	private lastMessage?: ApplicationMessage;
	private compatibilityAssets?: ApplicationAssets;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly markdown = new Map<string, { component: Markdown; text: string }>();
	private readonly attachments = new Map<string, ContentAttachmentComponent>();
	private readonly fullContent = new FullContentReader();
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		contentOptions: ContentOptions = {},
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.contentOptions = contentOptions;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.markdown.clear();
		if (this.lastMessage) {
			this.updateMessage(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateMessage(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateMessage(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.markdown.clear();
		for (const tool of this.tools.values()) tool.setOutputPad(padding);
		if (this.lastMessage) {
			this.updateMessage(this.lastMessage);
		}
	}

	attachTool(id: string, component: ToolExecutionComponent): void {
		this.tools.set(id, component);
		if (this.lastMessage) this.updateMessage(this.lastMessage);
	}

	setExpanded(expanded: boolean): void {
		for (const tool of this.tools.values()) tool.setExpanded(expanded);
	}

	setShowImages(showImages: boolean): void {
		this.contentOptions = { ...this.contentOptions, showImages };
		for (const attachment of this.attachments.values()) attachment.setShowImages(showImages);
		for (const tool of this.tools.values()) tool.setShowImages(showImages);
	}

	setImageWidthCells(imageWidthCells: number): void {
		this.contentOptions = { ...this.contentOptions, imageWidthCells };
		for (const attachment of this.attachments.values()) attachment.setImageWidthCells(imageWidthCells);
		for (const tool of this.tools.values()) tool.setImageWidthCells(imageWidthCells);
	}

	private markdownBlock(id: string, text: string, thinking = false): Markdown {
		let cached = this.markdown.get(id);
		if (!cached) {
			cached = {
				text,
				component: new Markdown(
					text,
					this.outputPad,
					0,
					this.markdownTheme,
					thinking ? { color: (value: string) => theme.fg("thinkingText", value), italic: true } : undefined,
					{
						transform: createMarkdownTransform(
							thinking ? "assistant-thinking" : "assistant",
							this.isStreaming,
							this.markdownTransformers,
						),
					},
				),
			};
			this.markdown.set(id, cached);
		} else if (cached.text !== text) {
			cached.component.setText(text);
			cached.text = text;
		}
		return cached.component;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const assets = (this.compatibilityAssets ??= new ApplicationAssets({ memory: true }));
		assets.clear();
		this.contentOptions.readAsset = (id) => assets.get(id);
		try {
			this.updateMessage(normalizeApplicationMessage(message, "assistant", assets), isStreaming);
		} catch (error) {
			this.updateMessage(
				{
					id: "assistant",
					role: "assistant",
					text: "",
					complete: true,
					status: "failed",
					stopReason: "error",
					errorMessage: `Content unavailable: ${error instanceof Error ? error.message : "Could not prepare output"}`,
				},
				false,
			);
		}
	}

	updateMessage(message: ApplicationMessage, isStreaming = this.isStreaming): void {
		message = this.fullContent.message(message, this.contentOptions.readAsset);
		this.lastMessage = message;
		if (this.isStreaming !== isStreaming) this.markdown.clear();
		this.isStreaming = isStreaming;
		const blocks = message.content ?? [{ id: `${message.id}:text`, type: "text" as const, text: message.text }];

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = blocks.some((c) => c.type !== "toolCall" && (c.type !== "text" || c.text.trim()));

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < blocks.length; i++) {
			const content = blocks[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = contentText(content, this.contentOptions.readAsset).trim();
				this.contentContainer.addChild(this.markdownBlock(content.id, text));
				for (const annotation of content.annotations ?? []) {
					const source = [annotation.title, annotation.url ?? annotation.fileId ?? annotation.text]
						.filter(Boolean)
						.join(" · ");
					if (source)
						this.contentContainer.addChild(new Text(theme.fg("dim", sanitizeTerminalText(source)), this.outputPad, 0));
				}
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < blocks.length; i++) {
					const thinkingContent = blocks[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = contentText(thinkingContent, this.contentOptions.readAsset).trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = blocks
					.slice(i + 1)
					.some((c) => (c.type === "text" || c.type === "thinking") && c.text.trim());

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const active = this.isStreaming && i === blocks.length - 1;
				const interrupted = !this.isStreaming && ["aborted", "error", "length"].includes(message.stopReason ?? "");
				const label = active ? "Thinking…" : interrupted ? "Reasoning interrupted" : "Reasoning";
				const thinkingComponent = new Container();
				thinkingComponent.addChild(
					new Text(
						theme.fg(interrupted ? "warning" : active ? "accent" : "thinkingText", `${hidden ? "▸" : "▾"} ${label}`) +
							(hidden ? theme.fg("dim", " · click to expand") : ""),
						this.outputPad,
						0,
					),
				);
				if (hidden && this.hiddenThinkingLabel !== "Thinking...") {
					thinkingComponent.addChild(new Text(this.hiddenThinkingLabel, this.outputPad, 0));
				}
				if (!hidden) {
					thinkingComponent.addChild(this.markdownBlock(content.id, thinkingBlocks.join("\n\n"), true));
				}
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateMessage(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			} else if (content.type === "toolCall") {
				const tool = this.tools.get(content.toolCallId);
				if (tool) this.contentContainer.addChild(tool);
			} else if (content.type !== "text") {
				let attachment = this.attachments.get(content.id);
				if (!attachment) {
					attachment = new ContentAttachmentComponent(content, this.contentOptions);
					this.attachments.set(content.id, attachment);
				} else attachment.updateBlock(content);
				this.contentContainer.addChild(attachment);
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = blocks.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("warning", sanitizeTerminalText(abortMessage)), this.outputPad, 0),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = sanitizeTerminalText(message.errorMessage || "Unknown error");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
