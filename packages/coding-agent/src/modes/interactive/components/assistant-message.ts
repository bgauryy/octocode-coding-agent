import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import {
	type Component,
	Container,
	GLYPH,
	type MarkdownTheme,
	MouseRegion,
	Osc133ZoneMarker,
	Spacer,
	Text,
	renderChanged,
	trackRenderChanges,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import { ApplicationAssets } from "../../../core/application/assets.ts";
import { normalizeApplicationMessage } from "../../../core/application/normalize.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import { STOPPED_COLOR } from "../../../octocode/render/types.ts";
import { toolInterruptShown } from "../../../core/application/interrupted-tools.ts";
import { AssistantMarkdown } from "./assistant-markdown.ts";
import { LongResponse } from "./long-response.ts";
import {
	ContentAttachmentComponent,
	contentText,
	transcriptContent,
	type ContentOptions,
} from "./application-content.ts";
import {
	finishedLabel,
	THINKING_LABEL,
	interruptedText,
	isAbortWording,
	observeThinking,
	revealHint,
	thinkingMs,
} from "./reasoning-label.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Renders a complete assistant message. */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private contentOptions: ContentOptions;
	private lastMessage?: ApplicationMessage;
	private readonly zone = new Osc133ZoneMarker();
	private compatibilityAssets?: ApplicationAssets;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly markdown = new AssistantMarkdown();
	private contentDirty = false;
	private readonly attachments = new Map<string, ContentAttachmentComponent>();
	private readonly fullContent = transcriptContent;
	private expanded = false;
	private readonly responseOverrides = new Map<string, boolean>();
	private readonly responses: LongResponse[] = [];
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	/** Whether a tool row already showed the interrupt; decided once, when the message first reads as interrupted. */
	private interruptShownByTool: boolean | undefined;
	/** A failed attempt the session sent again: its error is not the turn's outcome. */
	private retried = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		contentOptions: ContentOptions = {},
	) {
		super();
		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
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

	/** Shows or hides the thinking blocks; returns whether a drawn row changed (false without thinking blocks). */
	setHideThinkingBlock(hide: boolean): boolean {
		const overridden = this.thinkingVisibilityOverrides.size > 0;
		const changed = overridden || (hide !== this.hideThinkingBlock && this.hasThinking());
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (changed && this.lastMessage) this.updateMessage(this.lastMessage);
		return changed;
	}

	private hasThinking(): boolean {
		return this.lastMessage?.content?.some((block) => block.type === "thinking") === true;
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

	private markdownBlock(id: string, text: string, thinking = false): Component {
		return this.markdown.get(id, text, {
			streaming: this.isStreaming,
			thinking,
			padding: this.outputPad,
			theme: this.markdownTheme,
			transformers: this.markdownTransformers,
			cwd: this.contentOptions.cwd,
		});
	}

	override render(width: number): string[] {
		this.rebuildContent();
		const lines = super.render(width);
		return this.hasToolCalls ? lines : this.zone.mark(lines);
	}

	override get children(): Component[] {
		this.rebuildContent();
		return super.children;
	}

	override set children(children: Component[]) {
		super.children = children;
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
		this.rebuildContent();
	}

	/** Release the rendered Markdown; the component may still be rendered. */
	dispose(): void {
		this.contentDirty = false;
		this.markdown.clear();
	}

	updateMessage(received: ApplicationMessage, isStreaming = this.isStreaming): void {
		const message = this.fullContent.message(received, this.contentOptions.readAsset);
		if (received.complete) this.fullContent.forget(received.full);
		this.lastMessage = message;
		if (this.isStreaming !== isStreaming) this.markdown.clear();
		this.isStreaming = isStreaming;
		const now = Date.now();
		message.content?.forEach((block, index, blocks) => {
			if (block.type !== "thinking") return;
			// Only growth matters here: a long block's asset size, never its whole text re-read and trimmed per delta.
			const chars = block.full ? block.full.size : contentText(block).trim().length;
			observeThinking(block.id, chars, index < blocks.length - 1, now, isStreaming);
		});
		this.contentDirty = true;
		renderChanged(this);
		if (!isStreaming) this.rebuildContent();
	}

	/** Marks a failed attempt as one the session retried (`retried-attempts.ts`); a message that did not fail stays as it is. */
	markRetried(retried = true): void {
		if (this.retried === retried || this.lastMessage?.stopReason !== "error") return;
		this.retried = retried;
		this.contentDirty = true;
		renderChanged(this);
	}

	private addResponse(id: string, body: Component): void {
		const response = new LongResponse(
			body,
			this.responseOverrides.get(id) ?? this.expanded,
			(expanded) => this.responseOverrides.set(id, expanded),
			this.isStreaming,
			this.contentOptions.keepScrollbackOnCollapse,
		);
		this.responses.push(response);
		this.contentContainer.addChild(response);
	}

	/** Intermediate deltas update state; only a displayed frame or a completed message rebuilds its presentation. */
	private rebuildContent(): void {
		if (!this.contentDirty || !this.lastMessage) return;
		this.contentDirty = false;
		const message = this.lastMessage;
		const blocks = message.content ?? [{ id: `${message.id}:text`, type: "text" as const, text: message.text }];
		this.contentContainer.clear();
		this.responses.length = 0;

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
				const markdown = this.markdownBlock(content.id, text);
				if (!content.annotations?.length) {
					this.addResponse(content.id, markdown);
					continue;
				}
				const body = new Container();
				body.addChild(markdown);
				for (const annotation of content.annotations) {
					const source = [annotation.title, annotation.url ?? annotation.fileId ?? annotation.text]
						.filter(Boolean)
						.join(" · ");
					if (source) body.addChild(new Text(theme.fg("dim", sanitizeTerminalText(source)), this.outputPad, 0));
				}
				this.addResponse(content.id, body);
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
				// One still label, folded or open: only the fold glyph differs. The working line is the one moving
				// indicator, so a block that still streams says `Thinking…` without a spinner.
				const label = active ? THINKING_LABEL : finishedLabel(interrupted, elapsed);
				const hint = hidden ? revealHint() : "";
				const thinkingComponent = new Container();
				thinkingComponent.addChild(
					new Text(
						theme.fg(
							interrupted ? STOPPED_COLOR : "thinkingText",
							`${hidden ? GLYPH.collapsed : GLYPH.expanded} ${label}`,
						) + (hint ? theme.fg("dim", ` ${hint}`) : ""),
						this.outputPad,
						0,
					),
				);
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
			const line = this.retried
				? theme.fg("dim", `Retried after error: ${errorMsg}`)
				: theme.fg("error", `Error: ${errorMsg}`);
			this.contentContainer.addChild(new Spacer(1));
			this.addResponse(`${message.id}:error`, new Text(line, this.outputPad, 0));
		} else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
			// A tool row that already says `aborted` is the one statement of the interrupt.
			this.interruptShownByTool ??= toolInterruptShown();
			if (!this.interruptShownByTool) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(
						theme.fg(STOPPED_COLOR, sanitizeTerminalText(interruptedText(message.errorMessage))),
						this.outputPad,
						0,
					),
				);
			}
		}
	}
}
trackRenderChanges(AssistantMessageComponent.prototype); // Pending state is marked before its children are rebuilt.
