import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import {
	animationClock,
	Container,
	GLYPH,
	Markdown,
	type MarkdownTheme,
	MOTION,
	MouseRegion,
	Spacer,
	Text,
	trackRenderChanges,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import { ApplicationAssets } from "../../../core/application/assets.ts";
import { normalizeApplicationMessage } from "../../../core/application/normalize.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { toolInterruptShown } from "../../../core/application/interrupted-tools.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { LongResponse } from "./long-response.ts";
import { streamingMarkdownTheme } from "./streaming-highlight.ts";
import { Osc133ZoneMarker } from "./osc133-zone.ts";
import {
	ContentAttachmentComponent,
	contentText,
	transcriptContent,
	type ContentOptions,
} from "./application-content.ts";
import {
	durationSuffix,
	thoughtDuration,
	interruptedText,
	isAbortWording,
	LiveThinkingLabel,
	observeThinking,
	revealHint,
	thinkingMs,
} from "./reasoning-label.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** A live label that no render has drawn for this long belongs to a component that left the screen. */
const STALE_FRAME_MS = 2_000;

/** Renders a complete assistant message. */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private contentOptions: ContentOptions;
	private lastMessage?: ApplicationMessage;
	private readonly zone = new Osc133ZoneMarker();
	private compatibilityAssets?: ApplicationAssets;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly markdown = new Map<string, { component: Markdown; text: string }>();
	private readonly attachments = new Map<string, ContentAttachmentComponent>();
	private readonly fullContent = transcriptContent;
	private expanded = false;
	private readonly responseOverrides = new Map<string, boolean>();
	private readonly responses: LongResponse[] = [];
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private mouseHint = false;
	/** The frame subscription of a streaming reasoning label; held only while one is on screen. */
	private stopFrames: (() => void) | undefined;
	private liveLabel: LiveThinkingLabel | undefined;
	/** Whether a tool row already showed the interrupt; decided once, when the message first reads as interrupted. */
	private interruptShownByTool: boolean | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = true,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking…",
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

	/** Whether the terminal reports the mouse, so a hidden reasoning stub may say it can be clicked. */
	setMouseHint(mouse: boolean): void {
		if (this.mouseHint === mouse) return;
		this.mouseHint = mouse;
		if (this.lastMessage) this.updateMessage(this.lastMessage);
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
		this.expanded = expanded;
		this.responseOverrides.clear();
		for (const response of this.responses) response.setExpanded(expanded);
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
					this.isStreaming ? streamingMarkdownTheme(this.markdownTheme) : this.markdownTheme,
					thinking ? { color: (value: string) => theme.fg("thinkingText", value), italic: true } : undefined,
					{
						cwd: this.contentOptions.cwd,
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
		return this.hasToolCalls ? lines : this.zone.mark(lines);
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.compatibilityAssets ??= new ApplicationAssets({ memory: true });
		const assets = this.compatibilityAssets;
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
					errorMessage: `Content unavailable: ${errorMessage(error)}`,
				},
				false,
			);
		}
	}

	/**
	 * Ask for a frame every spinner step while a reasoning label streams, and not otherwise: the subscription ends with the
	 * stream, with this component (`dispose`), or once frames stop drawing the label (it left the transcript unannounced).
	 * Reduced motion keeps the subscription, but the clock does not tick decoration then.
	 */
	private syncFrames(): void {
		const requestRender = this.contentOptions.requestRender;
		if (!this.liveLabel || !requestRender) return this.dispose();
		if (this.stopFrames) return;
		this.stopFrames = animationClock.subscribe(
			(now) => {
				if (this.liveLabel && now - this.liveLabel.renderedAt < STALE_FRAME_MS) requestRender();
				else this.dispose();
			},
			{ everyMs: MOTION.spinnerMs, kind: "decor" },
		);
	}

	/** Stop asking for frames; the component may still be rendered, with a static label. */
	dispose(): void {
		this.stopFrames?.();
		this.stopFrames = undefined;
	}

	updateMessage(received: ApplicationMessage, isStreaming = this.isStreaming): void {
		const message = this.fullContent.message(received, this.contentOptions.readAsset);
		if (received.complete) this.fullContent.forget(received.full);
		this.lastMessage = message;
		if (this.isStreaming !== isStreaming) this.markdown.clear();
		this.isStreaming = isStreaming;
		const blocks = message.content ?? [{ id: `${message.id}:text`, type: "text" as const, text: message.text }];
		const now = Date.now();
		blocks.forEach((block, index) => {
			if (block.type !== "thinking") return;
			const chars = contentText(block, this.contentOptions.readAsset).trim().length;
			observeThinking(block.id, chars, index < blocks.length - 1, now, isStreaming);
		});

		this.contentContainer.clear();
		this.responses.length = 0;
		this.liveLabel = undefined;

		const hasVisibleContent = blocks.some((c) => c.type !== "toolCall" && (c.type !== "text" || c.text.trim()));

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		let thinkingRunIndex = 0;
		for (let i = 0; i < blocks.length; i++) {
			const content = blocks[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = contentText(content, this.contentOptions.readAsset).trim();
				const response = new LongResponse(
					this.markdownBlock(content.id, text),
					this.responseOverrides.get(content.id) ?? this.expanded,
					this.mouseHint,
					(expanded) => this.responseOverrides.set(content.id, expanded),
					isStreaming,
				);
				this.responses.push(response);
				this.contentContainer.addChild(response);
				for (const annotation of content.annotations ?? []) {
					const source = [annotation.title, annotation.url ?? annotation.fileId ?? annotation.text]
						.filter(Boolean)
						.join(" · ");
					if (source)
						this.contentContainer.addChild(new Text(theme.fg("dim", sanitizeTerminalText(source)), this.outputPad, 0));
				}
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				const spanIds: string[] = [];
				for (; i < blocks.length; i++) {
					const thinkingContent = blocks[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					spanIds.push(thinkingContent.id);
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
				const elapsed = thinkingMs(spanIds);
				// A collapsed, finished block reads as a past event ("Thought for 4s"); an open one titles its text.
				const label = interrupted ? "Reasoning interrupted" : hidden ? "Thought" : "Reasoning";
				const time = hidden && !interrupted ? thoughtDuration(elapsed) : durationSuffix(elapsed);
				const hint = hidden ? revealHint(this.mouseHint) : "";
				const thinkingComponent = new Container();
				if (active) {
					this.liveLabel = new LiveThinkingLabel(hint, this.outputPad);
					thinkingComponent.addChild(this.liveLabel);
				} else {
					thinkingComponent.addChild(
						new Text(
							theme.fg(
								interrupted ? "warning" : "thinkingText",
								`${hidden ? GLYPH.collapsed : GLYPH.expanded} ${label}${time}`,
							) + (hint ? theme.fg("dim", ` ${hint}`) : ""),
							this.outputPad,
							0,
						),
					);
				}
				if (hidden && this.hiddenThinkingLabel !== "Thinking…") {
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

		this.syncFrames();

		// Check if incomplete/failed - show after partial content.
		// An abort with tool calls shows on their rows. A failure shows its error here once; its tool rows say not run.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = blocks.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (message.stopReason === "error" && !isAbortWording(message.errorMessage)) {
			const errorMsg = sanitizeTerminalText(message.errorMessage || "Unknown error");
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
		} else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
			// A tool row that already says `aborted` is the one statement of the interrupt.
			this.interruptShownByTool ??= toolInterruptShown();
			if (!this.interruptShownByTool) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("warning", sanitizeTerminalText(interruptedText(message.errorMessage))), this.outputPad, 0),
				);
			}
		}
	}
}
trackRenderChanges(AssistantMessageComponent.prototype); // Its rows' state changes only where it rebuilds its children.
