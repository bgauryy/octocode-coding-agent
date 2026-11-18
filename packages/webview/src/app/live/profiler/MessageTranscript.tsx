import type { ProfileTranscriptEntry, TranscriptRef } from "@octocodeai/octocode-contracts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useEffect, useState } from "react";
import { useLive } from "../session.tsx";

/** Thinking up to this long shows inline; longer thinking stays behind a toggle. */
const INLINE_THINKING_CHARS = 280;

function Thinking({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	if (text.length <= INLINE_THINKING_CHARS) return <p className="pf-tr-thinking">{text}</p>;
	return (
		<div>
			<button type="button" className="pf-t-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? "Hide thinking" : `Show thinking (${text.length.toLocaleString("en-US")} characters)`}
			</button>
			{open ? <pre className="pf-tr-thinking">{text}</pre> : null}
		</div>
	);
}

function Entry({ item, near }: { item: ProfileTranscriptEntry; near: boolean }) {
	return (
		<li className={`pf-tr-entry${near ? " is-near" : ""}`} aria-label={`${item.role} entry ${item.entry}`}>
			<p className="pf-tr-head muted">
				{item.role} {"\u00B7"} entry {item.entry}
				{near ? " \u00B7 nearest the send" : ""}
				{item.tools?.length ? ` \u00B7 called ${item.tools.join(", ")}` : ""}
			</p>
			{item.thinking ? <Thinking text={item.thinking} /> : null}
			{item.text ? <pre className="pf-tr-text">{item.text}</pre> : null}
			{item.truncated ? <p className="muted">Cut at the size the page holds.</p> : null}
		</li>
	);
}

/** The sender's thinking and output around the entry its message points at, read when the message is selected; key it by the ref to read another. */
export function MessageTranscript({ transcript }: { transcript: TranscriptRef }) {
	const { api } = useLive();
	const [loaded, setLoaded] = useState<{ entries: ProfileTranscriptEntry[] } | { error: string }>();
	const { agentId, entry, sessionId } = transcript;
	useEffect(() => {
		const controller = new AbortController();
		api
			.profilerTranscript(agentId, entry, sessionId, controller.signal)
			.then((value) => setLoaded({ entries: value.entries }))
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setLoaded({ error: errorMessage(reason) });
			});
		return () => controller.abort();
	}, [api, agentId, entry, sessionId]);

	return (
		<section className="pf-tr" aria-label={`${agentId} near the send`}>
			<h4>{agentId} near the send</h4>
			{!loaded ? (
				<p className="muted">Loading{"\u2026"}</p>
			) : "error" in loaded ? (
				<p className="pf-error" role="alert">
					{loaded.error}
				</p>
			) : loaded.entries.length ? (
				<ol className="pf-tr-list">
					{loaded.entries.map((item) => (
						<Entry key={item.entry} item={item} near={item.entry === entry} />
					))}
				</ol>
			) : (
				<p className="muted">That part of the transcript is no longer available.</p>
			)}
		</section>
	);
}
