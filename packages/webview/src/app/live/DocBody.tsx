/* oxlint-disable react/no-array-index-key -- the pieces of one text node are positional and never reordered */
import { Fragment, useMemo } from "react";
import type { BacklogIndex } from "../model/backlog.ts";
import { splitBacklogRefs } from "../model/docs.ts";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { renderMarkdown } from "./Markdown.tsx";

/**
 * One document as sanitized Markdown. ```mermaid blocks become diagrams, and a backlog id the board holds links to its
 * item; ids inside code or links, and ids the board does not hold, stay text.
 */
export function DocBody({ text, index }: { text: string; index: BacklogIndex }) {
	const content = useMemo(
		() =>
			renderMarkdown(text, {
				code: (language, source, key) =>
					language === "mermaid" ? <MermaidBlock key={key} source={source} /> : undefined,
				text: (value) =>
					splitBacklogRefs(value, (ref) => index.byRef.has(ref)).map((part, position) =>
						typeof part === "string" ? (
							<Fragment key={position}>{part}</Fragment>
						) : (
							<a key={position} className="ref" href={`#${part.ref}`}>
								{part.ref}
							</a>
						),
					),
			}),
		[text, index.byRef],
	);
	return <div className="markdown-body doc-body">{content}</div>;
}
