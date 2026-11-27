import { knownToolDisplayBlock, type ToolDisplay, type ToolDisplayBlock } from "@octocodeai/octocode-contracts";
import { isJsonDocument, jsonSpans } from "@octocodeai/octocode-common/json-color";
import { type ReactNode, useMemo, useState } from "react";
import { cx } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

/** Lines of a collapsed text or output block; the rest is one click away. */
const PREVIEW_LINES = 12;

function Preview({
	text,
	tail,
	className,
	draw,
}: {
	text: string;
	tail?: boolean;
	className: string;
	/** Draws the shown lines (syntax colour); the plain text by default. */
	draw?: (shown: string) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const lines = text.replace(/\n$/, "").split("\n");
	const hidden = lines.length - PREVIEW_LINES;
	const shown = open || hidden <= 0 ? lines : tail ? lines.slice(-PREVIEW_LINES) : lines.slice(0, PREVIEW_LINES);
	return (
		<div className="tool-display-preview">
			<pre className={className}>{draw ? draw(shown.join("\n")) : shown.join("\n")}</pre>
			{hidden > 0 && (
				<button type="button" className="link-button" onClick={() => setOpen(!open)}>
					{open ? "Show less" : `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`}
				</button>
			)}
		</div>
	);
}

/** Class of the `hljs` token colours the code blocks use, per JSON token. */
const JSON_TOKEN: Record<string, string> = {
	syntaxVariable: "hljs-attr",
	syntaxString: "hljs-string",
	syntaxNumber: "hljs-number",
	syntaxPunctuation: "hljs-punctuation",
};

/** A text block that is one JSON document: indented and coloured, every token copied as sent (no number is parsed). */
function JsonText({ text, tail }: { text: string; tail?: boolean }) {
	const pretty = useMemo(
		() =>
			jsonSpans(text, true)
				.map((span) => span.text)
				.join(""),
		[text],
	);
	return (
		<Preview
			text={pretty}
			tail={tail}
			className="text output json-output"
			draw={(shown) =>
				jsonSpans(shown, false).map((span, index) =>
					span.color ? (
						// oxlint-disable-next-line react/no-array-index-key -- spans are positional and never reorder.
						<span key={index} className={JSON_TOKEN[span.color]}>
							{span.text}
						</span>
					) : (
						span.text
					),
				)
			}
		/>
	);
}

/** One block; a type this version does not know shows its text. */
function Block({ block }: { block: ToolDisplayBlock }) {
	const known = knownToolDisplayBlock(block);
	switch (known?.type) {
		case "text":
			if (!known.tone && isJsonDocument(known.text.trim()))
				return <JsonText text={known.text.trim()} tail={known.preview === "tail"} />;
			return (
				<Preview
					text={known.text}
					tail={known.preview === "tail"}
					className={cx("text", "output", known.tone && `tone-${known.tone}`)}
				/>
			);
		case "output":
			return (
				<figure className="tool-output">
					{known.command && (
						<figcaption>
							<code>$ {known.command}</code>
							{known.exitCode !== undefined && <span className="muted"> exit {known.exitCode}</span>}
							{known.timedOut && <span className="muted"> timed out</span>}
						</figcaption>
					)}
					<Preview text={known.text} tail className="text output" />
				</figure>
			);
		case "diff":
			return (
				<DiffView diffs={known.files.map((file) => ({ path: file.path, type: file.operation, diff: file.patch }))} />
			);
		case "list":
			return (
				<ul className="tool-display-list">
					{known.items.map((item, index) => (
						// oxlint-disable-next-line react/no-array-index-key -- list items are positional and never reorder.
						<li key={index} className={cx(item.tone && `tone-${item.tone}`)}>
							{item.state && <StateMark state={item.state} size={12} />} {item.text}
							{item.detail && <div className="muted">{item.detail}</div>}
						</li>
					))}
				</ul>
			);
		case "fields":
			return (
				<dl className="tool-display-fields">
					{known.entries.map((entry, index) => (
						// oxlint-disable-next-line react/no-array-index-key -- entries are positional and may repeat a label.
						<div key={index}>
							<dt>{entry.label}</dt>
							<dd>{entry.value}</dd>
						</div>
					))}
				</dl>
			);
		case "markdown":
			return <Markdown text={known.text} />;
		case "path":
			return (
				<p className="muted tool-display-path">
					{known.label}: <code>{known.path}</code>
				</p>
			);
		default:
			return <pre className="text output">{block.text}</pre>;
	}
}

/** A tool call as its display describes it: sub-lines, the outcome line, then the blocks (the prompt preface folded). */
export function ToolDisplayView({ display }: { display: ToolDisplay }) {
	return (
		<div className="tool-display">
			{display.subjects?.length ? (
				<ul className="tool-display-subjects">
					{display.subjects.map((subject, index) => (
						// oxlint-disable-next-line react/no-array-index-key -- sub-lines are positional.
						<li key={index}>{subject}</li>
					))}
				</ul>
			) : null}
			{display.outcome && (
				<p
					className={cx(
						"tool-display-outcome",
						display.outcome.stopped ? "tone-warning" : display.outcome.tone && `tone-${display.outcome.tone}`,
					)}
				>
					⎿ {display.outcome.text}
				</p>
			)}
			{display.preface?.length ? (
				<details className="result-details">
					<summary>Prompt</summary>
					{display.preface.map((block, index) => (
						// oxlint-disable-next-line react/no-array-index-key -- blocks are positional.
						<Block key={index} block={block} />
					))}
				</details>
			) : null}
			{display.blocks.map((block, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- blocks are positional.
				<Block key={index} block={block} />
			))}
		</div>
	);
}
