import { type ComponentType, createContext, useContext } from "react";
import { plural } from "../model/format.ts";

/** The live page renders Markdown; the offline export shows literal text. */
export const RichTextContext = createContext<ComponentType<{ text: string }> | null>(null);

const FOLD_CHARS = 700;
const FOLD_LINES = 14;

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
	const lines = text.split("\n").length;
	if (text.length <= FOLD_CHARS && lines <= FOLD_LINES) return body;
	return (
		<details className="fold" open={RichText !== null}>
			<summary>
				{label}: {plural(lines, "line")}, {plural(text.length, "character")}
			</summary>
			{body}
		</details>
	);
}
