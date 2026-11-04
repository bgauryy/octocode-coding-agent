import { Box, Container, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import type { ApplicationContentBlock } from "@octocodeai/octocode-contracts";
import { ApplicationAssets } from "../../../../core/application/assets.ts";
import { normalizeApplicationContent } from "../../../../core/application/normalize.ts";
import { formatToolCallWithArgs } from "../../../../core/tools/render-utils.ts";
import { theme } from "../../../../theme/theme.ts";
import { ContentAttachmentComponent, contentText } from "../application-content.ts";
import { formatDuration } from "../../../../octocode/shared/format.ts";
import { keyHint } from "../keybinding-hints.ts";
import { reasonRow } from "./reason.ts";
import type { ToolExecutionResult } from "./types.ts";

interface GenericToolDisplay {
	/** The row's painted state mark. */
	mark: string;
	toolName: string;
	toolCallId: string;
	args: unknown;
	content: ToolExecutionResult["content"];
	expanded: boolean;
	showImages: boolean;
	imageWidthCells: number;
	outputPad: number;
	background: (text: string) => string;
	/** The finished result failed: its output reads in text colour, not muted. */
	isError?: boolean;
	/** How long the finished call took; shown after the title. */
	durationMs?: number;
}

/** Ordered generic output, including image fallbacks. Custom tool renderers keep ownership of their own layout. */
export class GenericToolContent extends Container {
	private readonly assets = new ApplicationAssets({ memory: true });
	private readonly attachments = new Map<string, ContentAttachmentComponent>();
	private readonly requestRender: () => void;
	/** One reader for the component's life: an attachment keeps its Image (and Kitty image id) only while the reader is the same. */
	private readonly readAsset = (id: string) => this.assets.get(id);
	constructor(requestRender: () => void) {
		super();
		this.requestRender = requestRender;
	}

	update(display: GenericToolDisplay): void {
		this.clear();
		this.assets.clear();
		this.addChild(
			new Text(
				`${display.mark} ${formatToolCallWithArgs(sanitizeTerminalText(display.toolName), display.args, theme, display.expanded)}${
					display.durationMs === undefined ? "" : theme.fg("muted", ` · ${formatDuration(display.durationMs)}`)
				}`,
				display.outputPad,
				1,
				display.background,
			),
		);
		const reason = reasonRow(display.toolName, display.args);
		if (reason) {
			const row = new Box(display.outputPad, 0, display.background);
			row.addChild(reason);
			this.addChild(row);
		}
		let content: ApplicationContentBlock[];
		try {
			content = normalizeApplicationContent(display.content, display.toolCallId, this.assets);
		} catch (error) {
			content = [
				{
					id: `${display.toolCallId}:unavailable`,
					type: "unsupported",
					providerType: "tool-result",
					text: `Content unavailable: ${error instanceof Error ? error.message : "Could not prepare output"}`,
				},
			];
		}
		const options = {
			readAsset: this.readAsset,
			showImages: display.showImages,
			imageWidthCells: display.imageWidthCells,
			requestRender: this.requestRender,
		};
		let remaining = display.expanded ? Number.POSITIVE_INFINITY : 10;
		let omitted = 0;
		const activeAttachments = new Set<string>();
		for (const block of content) {
			if (block.type === "image") {
				activeAttachments.add(block.id);
				let attachment = this.attachments.get(block.id);
				if (!attachment) {
					attachment = new ContentAttachmentComponent(block, options);
					this.attachments.set(block.id, attachment);
				} else attachment.updateBlock(block, options);
				this.addChild(attachment);
				continue;
			}
			const lines = sanitizeTerminalText(contentText(block, options.readAsset)).split("\n");
			const visible = lines.slice(0, remaining);
			remaining -= visible.length;
			omitted += lines.length - visible.length;
			if (visible.length)
				this.addChild(
					new Text(
						visible.map((line) => theme.fg(display.isError ? "text" : "toolOutput", line)).join("\n"),
						display.outputPad,
						0,
						display.background,
					),
				);
		}
		for (const id of this.attachments.keys()) if (!activeAttachments.has(id)) this.attachments.delete(id);
		if (omitted)
			this.addChild(
				new Text(
					`${theme.fg("muted", `… (${omitted} more lines)`)} ${keyHint("app.tools.expand", "to expand")}`,
					display.outputPad,
					0,
					display.background,
				),
			);
	}
}
