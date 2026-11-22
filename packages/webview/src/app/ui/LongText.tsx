import { type ComponentType, type ReactNode, createContext, useContext, useState } from "react";
import { plural } from "../model/format.ts";

/** The live page renders Markdown; the offline export shows literal text. */
export const RichTextContext = createContext<ComponentType<{ text: string }> | null>(null);

const FOLD_CHARS = 700;
const FOLD_LINES = 14;

/** Keep expensive Markdown and large literal blocks out of the page until the reader opens them. */
export function TextFold({
	text,
	label,
	children,
	summary,
	initiallyOpen = false,
}: {
	text: string;
	label: string;
	children: ReactNode;
	summary?: string;
	initiallyOpen?: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	const lines = 1 + (text.match(/\n/g)?.length ?? 0);
	if (!summary && text.length <= FOLD_CHARS && lines <= FOLD_LINES) return children;
	return (
		<details className="fold" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>{summary ?? `${label}: ${plural(lines, "line")}, ${plural(text.length, "character")}`}</summary>
			{open && children}
		</details>
	);
}

/** A text block; long text folds into a disclosure and stays whole. `plain` keeps tool output literal and monospaced. */
export function LongText({ text, label, plain = false }: { text: string; label: string; plain?: boolean }) {
	const RichText = useContext(RichTextContext);
	const body =
		RichText && !plain ? (
			// oxlint-disable-next-line react/static-components -- the context supplies one module-level renderer; nothing is created during render.
			<RichText text={text} />
		) : (
			<pre className={plain ? "text output" : "text"}>{text}</pre>
		);
	return (
		<TextFold text={text} label={label}>
			{body}
		</TextFold>
	);
}
