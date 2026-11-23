import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type EvidenceRead, parseAnchor } from "@octocodeai/octocode-contracts/evidence";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";

/** Reads one recorded message by anchor string through the host; absent where the page has no live session. */
export type EvidenceReader = (anchor: string, cursor?: string) => Promise<EvidenceRead>;
export const EvidenceContext = createContext<EvidenceReader | undefined>(undefined);

const ANCHOR_TEXT = /\b(?:archive|transcript):[^\s"'<>)\]]+/g;

/** Plain text with each well-formed source anchor turned into a control that opens what it names. */
export function linkAnchors(text: string): ReactNode {
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(ANCHOR_TEXT)) {
		if (!parseAnchor(match[0])) continue;
		parts.push(text.slice(last, match.index), <EvidenceAnchor key={`${match.index}`} anchor={match[0]} />);
		last = match.index + match[0].length;
	}
	if (parts.length === 0) return text;
	parts.push(text.slice(last));
	return parts;
}

/** An anchor shown as a button; the recorded text opens under it only when asked for. */
function EvidenceAnchor({ anchor }: { anchor: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="evidence-anchor" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<code>{anchor}</code>
			</button>
			{open && <EvidencePanel anchor={anchor} />}
		</>
	);
}

/** The recorded message an anchor names: author, time, availability, text, and a button for the next part. */
function EvidencePanel({ anchor }: { anchor: string }) {
	const read = useContext(EvidenceContext);
	const [reads, setReads] = useState<EvidenceRead[]>([]);
	const [error, setError] = useState<string | undefined>();
	/** How many parts the reader asked for; fewer reads than that means one is on its way. */
	const [asked, setAsked] = useState(1);
	const last = reads.at(-1);
	useEffect(() => {
		if (!read || error !== undefined || reads.length >= asked) return;
		let current = true;
		read(anchor, last?.nextCursor).then(
			(value) => current && setReads((previous) => [...previous, value]),
			(failure: unknown) => current && setError(errorMessage(failure)),
		);
		return () => {
			current = false;
		};
	}, [read, anchor, asked, reads.length, last?.nextCursor, error]);
	if (error !== undefined) return <span className="evidence-panel muted">{error}</span>;
	const first = reads[0];
	const loading = reads.length < asked;
	return (
		<section className="evidence-panel" aria-label="Recorded text">
			{first && first.availability !== "present" ? (
				<span className="muted">
					{first.availability === "expired"
						? "This history was removed by retention."
						: "This anchor is not available in this session's history."}
				</span>
			) : (
				<>
					{first && <span className="muted">{[first.author, first.time].filter(Boolean).join(" · ")}</span>}
					<pre className="evidence-text">{reads.map((value) => value.text ?? "").join("")}</pre>
				</>
			)}
			{loading && <span className="muted">Loading…</span>}
			{!loading && last?.nextCursor && (
				<Button size="sm" variant="ghost" onClick={() => setAsked(reads.length + 1)}>
					More
				</Button>
			)}
		</section>
	);
}
