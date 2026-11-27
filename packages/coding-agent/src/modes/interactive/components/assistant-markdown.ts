import type { ApplicationContentBlock, ApplicationMessage } from "@octocodeai/octocode-contracts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import {
	type Component,
	type Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	StreamingText,
	Text,
} from "@octocodeai/octocode-tui";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import { STOPPED_COLOR } from "../../../octocode/render/types.ts";
import { theme } from "../../../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { interruptedText, isAbortWording } from "./reasoning-label.ts";

interface Options {
	streaming: boolean;
	thinking: boolean;
	padding: number;
	theme: MarkdownTheme;
	transformers: readonly MarkdownTransformer[];
	cwd?: string;
}

type Block = Markdown | StreamingText;

/**
 * The components of an assistant message's text and thinking blocks, reused by block id. A block that is still
 * streaming shows as plain wrapped text; a finished one renders as Markdown once. The caller clears the entries when
 * the message stops streaming, so a finished block never keeps its plain view.
 */
export class AssistantMarkdown {
	private readonly entries = new Map<string, { component: Block; text: string }>();

	get(id: string, text: string, options: Options): Component {
		let cached = this.entries.get(id);
		if (!cached) {
			cached = { text, component: create(text, options) };
			this.entries.set(id, cached);
		} else if (cached.text !== text) {
			cached.component.setText(text);
			cached.text = text;
		}
		return cached.component;
	}

	clear(): void {
		this.entries.clear();
	}
}

function create(text: string, options: Options): Block {
	const { thinking, streaming } = options;
	const transform = createMarkdownTransform(
		thinking ? "assistant-thinking" : "assistant",
		streaming,
		options.transformers,
	);
	if (streaming) {
		const style = thinking ? (line: string) => options.theme.italic(theme.fg("thinkingText", line)) : undefined;
		return new StreamingText(text, options.padding, style, transform, options.transformers.length === 0);
	}
	return new Markdown(
		text,
		options.padding,
		0,
		options.theme,
		thinking ? { color: (value) => theme.fg("thinkingText", value), italic: true } : undefined,
		{ cwd: options.cwd, transform },
	);
}

/**
 * Structural key of a streaming assistant message's blocks: when unchanged between streaming deltas, existing
 * `StreamingText` and attachment children can be updated in place without clearing `contentContainer`.
 */
function streamingBlocksSignature(
	blocks: readonly ApplicationContentBlock[],
	hasTool: (id: string) => boolean,
	isThinkingHidden: (runIndex: number) => boolean,
	readText: (block: ApplicationContentBlock) => string,
): string {
	const parts: string[] = [];
	let thinkingRun = 0;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "text") {
			if (b.text.trim()) parts.push(`t:${b.id}:${b.annotations?.length ?? 0}`);
		} else if (b.type === "thinking") {
			let hasText = false;
			const firstId = b.id;
			for (; i < blocks.length && blocks[i].type === "thinking"; i++) {
				if (readText(blocks[i]).trim()) hasText = true;
			}
			i--;
			if (!hasText) continue;
			const run = thinkingRun++;
			const active = i === blocks.length - 1;
			parts.push(`k:${firstId}:${run}:${isThinkingHidden(run) ? "h" : "s"}:${active ? "a" : "f"}`);
		} else if (b.type === "toolCall") {
			parts.push(`c:${b.toolCallId}:${hasTool(b.toolCallId) ? 1 : 0}`);
		} else {
			parts.push(`a:${b.id}:${b.type}`);
		}
	}
	return parts.join("|");
}

/** Update existing streaming markdown/attachment blocks in place when `streamingBlocksSignature` did not change. */
export function tryUpdateStreamingBlocks(options: {
	blocks: readonly ApplicationContentBlock[];
	previousSignature: string | undefined;
	hasMountedChildren: boolean;
	hasTool: (id: string) => boolean;
	isThinkingHidden: (runIndex: number) => boolean;
	readText: (block: ApplicationContentBlock) => string;
	updateMarkdown: (id: string, text: string, thinking?: boolean) => void;
	updateAttachment: (block: ApplicationContentBlock) => void;
}): { updated: boolean; signature: string } {
	const { blocks, previousSignature, hasMountedChildren, hasTool, isThinkingHidden, readText } = options;
	const signature = streamingBlocksSignature(blocks, hasTool, isThinkingHidden, readText);
	if (signature !== previousSignature || !hasMountedChildren) return { updated: false, signature };
	let thinkingRun = 0;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "text" && b.text.trim()) {
			options.updateMarkdown(b.id, readText(b).trim());
		} else if (b.type === "thinking") {
			const parts: string[] = [];
			for (; i < blocks.length && blocks[i].type === "thinking"; i++) {
				const t = readText(blocks[i]).trim();
				if (t) parts.push(t);
			}
			i--;
			if (parts.length === 0) continue;
			if (!isThinkingHidden(thinkingRun++)) options.updateMarkdown(b.id, parts.join("\n\n"), true);
		} else if (b.type !== "toolCall" && b.type !== "text") {
			options.updateAttachment(b);
		}
	}
	return { updated: true, signature };
}

/** Appends truncation, error, or interruption footer lines to an assistant message container. */
export function appendStopReasonFooter(options: {
	message: ApplicationMessage;
	hasToolCalls: boolean;
	retried: boolean;
	outputPad: number;
	container: Container;
	addResponse: (id: string, body: Component) => void;
	isInterruptShownByTool: () => boolean;
}): void {
	const { message, hasToolCalls, retried, outputPad, container, addResponse, isInterruptShownByTool } = options;
	if (message.stopReason === "length") {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", "Response was truncated before completion."), outputPad, 0));
	} else if (message.stopReason === "error" && !isAbortWording(message.errorMessage)) {
		const errorMsg = sanitizeTerminalText(message.errorMessage || "Unknown error");
		const line = retried
			? theme.fg("dim", `Retried after error: ${errorMsg}`)
			: theme.fg("error", `Error: ${errorMsg}`);
		container.addChild(new Spacer(1));
		addResponse(`${message.id}:error`, new Text(line, outputPad, 0));
	} else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
		if (!isInterruptShownByTool()) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg(STOPPED_COLOR, sanitizeTerminalText(interruptedText(message.errorMessage))), outputPad, 0),
			);
		}
	}
}
