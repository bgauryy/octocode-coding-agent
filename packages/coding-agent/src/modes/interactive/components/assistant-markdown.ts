import { Markdown, type MarkdownTheme } from "@octocodeai/octocode-tui";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import { theme } from "../../../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { streamingMarkdownTheme } from "./streaming-highlight.ts";

interface Options {
	streaming: boolean;
	thinking: boolean;
	padding: number;
	theme: MarkdownTheme;
	transformers: readonly MarkdownTransformer[];
	cwd?: string;
}

/** Reuses blocks while keeping at most the last visible streaming block's bounded parse cache alive. */
export class AssistantMarkdown {
	private readonly entries = new Map<string, { component: Markdown; text: string }>();
	private active: Markdown | undefined;

	get(id: string, text: string, options: Options): Markdown {
		let cached = this.entries.get(id);
		if (!cached) {
			const { thinking, streaming } = options;
			cached = {
				text,
				component: new Markdown(
					text,
					options.padding,
					0,
					streaming ? streamingMarkdownTheme(options.theme) : options.theme,
					thinking ? { color: (value) => theme.fg("thinkingText", value), italic: true } : undefined,
					{
						cwd: options.cwd,
						transform: createMarkdownTransform(
							thinking ? "assistant-thinking" : "assistant",
							streaming,
							options.transformers,
						),
					},
				),
			};
			this.entries.set(id, cached);
		} else if (cached.text !== text) {
			cached.component.setText(text);
			cached.text = text;
		}
		if (this.active !== cached.component) this.active?.setStreaming(false);
		this.active = options.streaming ? cached.component : undefined;
		cached.component.setStreaming(options.streaming);
		return cached.component;
	}

	clear(): void {
		for (const { component } of this.entries.values()) component.dispose();
		this.active = undefined;
		this.entries.clear();
	}
}
