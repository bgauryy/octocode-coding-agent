import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { Button } from "../ui/primitives.tsx";

type Awaiting = NonNullable<ApplicationSnapshot["awaiting"]>;

const PREVIEW_LINES = 3;

/**
 * What the terminal's ask card shows above its options, for the page: dim metadata lines, the quoted body (folded to its
 * preview while the host marks it collapsible; approved targets never are) and the details block (effect, undo, why it
 * asks, risk) behind a toggle. Text only: the host already redacted it, and React escapes it.
 */
export function DialogAnswerCard({ awaiting }: { awaiting: Awaiting }) {
	const [expanded, setExpanded] = useState(false);
	const { meta, body, details } = awaiting;
	const question = awaiting.question?.trim();
	const lines = body ? body.text.split(/\r\n|\r|\n/) : [];
	const preview = body?.collapsible ? (body.previewLines ?? PREVIEW_LINES) : lines.length;
	const hidden = expanded ? 0 : Math.max(0, lines.length - preview);
	if (!question && !meta?.length && !body && !details?.length) return null;
	return (
		<div className="dialog-answer-card">
			{question ? <p className="dialog-answer-question">{question}</p> : null}
			{meta?.map((line) => (
				<p className="muted dialog-answer-meta" key={line}>
					{line}
				</p>
			))}
			{body ? (
				<>
					{body.label ? <p className="muted dialog-answer-meta">{body.label}</p> : null}
					<blockquote className="dialog-answer-body">{lines.slice(0, lines.length - hidden).join("\n")}</blockquote>
					{body.collapsible && lines.length > preview ? (
						<Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
							{expanded ? "Show less" : `Show all (+${hidden} lines)`}
						</Button>
					) : null}
				</>
			) : null}
			{details?.length ? (
				<details className="dialog-answer-details">
					<summary>Details</summary>
					{details.map((note) => (
						<p className={note.tone === "warning" ? "dialog-answer-warning" : "muted"} key={note.text}>
							{note.text}
						</p>
					))}
				</details>
			) : null}
		</div>
	);
}
