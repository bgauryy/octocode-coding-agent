import { type Component, Markdown, type MarkdownTheme, StreamingText } from "@octocodeai/octocode-tui";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import { theme } from "../../../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

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
		return new StreamingText(text, options.padding, style, transform);
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
