import { type Component, Markdown, renderChanged, trackRenderChanges, visibleWidth } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { getMarkdownTheme, type Theme } from "../../theme/theme.ts";
import { expandHint, INDENT, plural } from "../shared/text.ts";

/**
 * A subagent's report under its result row, rendered as Markdown like an assistant answer. The text is untrusted, so
 * it is sanitized first. The whole report is drawn, collapsed or not: it is the deliverable, so it never folds.
 */
export class ReportView implements Component {
	private readonly markdown: Markdown;
	private readonly theme: Theme;
	private readonly expanded: boolean;
	private cache: { width: number; lines: string[] } | undefined;

	private readonly more: string | undefined;
	private readonly earlier: number;

	/**
	 * `more` names what expanding also shows (such as the prompt), for the hint after a report that does not fold;
	 * `earlier` counts older reports the collapsed view leaves out, one line above this one.
	 */
	constructor(theme: Theme, report: string, expanded: boolean, more?: string, earlier = 0) {
		this.theme = theme;
		this.expanded = expanded;
		this.more = more;
		this.earlier = expanded ? 0 : earlier;
		this.markdown = new Markdown(sanitizeTerminalText(report).trim(), 0, 0, getMarkdownTheme(theme));
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const body = this.markdown.render(Math.max(1, width - visibleWidth(INDENT))).map((line) => `${INDENT}${line}`);
		while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
		const more = this.more !== undefined && !this.expanded;
		const hint = (text: string) => `${INDENT}${this.theme.fg("dim", [text, expandHint()].filter(Boolean).join(" "))}`;
		const earlier = this.earlier > 0 ? [hint(`+${plural(this.earlier, "earlier report")}`)] : [];
		const lines = earlier.concat(more ? [...body, hint(`… ${this.more}`)] : body);
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.markdown.invalidate();
		renderChanged(this);
	}
}
// Built once from its report; a look change reaches it through `invalidate`.
trackRenderChanges(ReportView.prototype);
