import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { ApplicationProjection } from "./application-projection.ts";
import { ActivityHistory } from "./ActivityHistory.tsx";
import { addHistoryPage, type LoadedHistory, requestHistory, retainEvicted } from "./history-window.ts";
import { ResultCard } from "./ResultCard.tsx";
import { useLive } from "./session.tsx";

/** History pages are explicit reads; they never replace or rewind the live event cursor. */
export function HistoryPanel() {
	const store = useLive().session;
	const snapshot = useStore(store, (state) => state.application);
	const revision = useStore(store, (state) => state.historyRevision);
	return snapshot ? (
		<div key={`${snapshot.sessionId}:${revision}`}>
			<HistoryPages snapshot={snapshot} />
			<ActivityHistory snapshot={snapshot} />
		</div>
	) : null;
}

function HistoryPages({ snapshot }: { snapshot: ApplicationSnapshot }) {
	const { api, session } = useLive();
	const [history, setHistory] = useState<LoadedHistory>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	// The projection is an incremental row cache; one instance lives as long as this history.
	const [projection] = useState(() => new ApplicationProjection());
	const live = useRef(snapshot);
	const { sessionId } = snapshot;
	// The live window drops its oldest messages as new ones arrive; once history is shown they move into it before paint.
	useLayoutEffect(() => {
		const previous = live.current;
		live.current = snapshot;
		if (previous !== snapshot) setHistory((current) => current && retainEvicted(current, previous, snapshot));
	}, [snapshot]);
	const events = useMemo(
		() =>
			history
				? projection
						.update(
							{
								sessionId,
								messages: history.messages,
								tools: history.tools,
								streaming: false,
								steering: [],
								followUp: [],
								receipts: [],
								capabilities: [],
							},
							0,
						)
						.filter((event) => !event.embedded)
				: [],
		[history, projection, sessionId],
	);
	async function load() {
		setLoading(true);
		setError("");
		const cursor = requestHistory(history, snapshot.messages[0]?.id).before;
		setHistory((current) => requestHistory(current, snapshot.messages[0]?.id));
		try {
			const page = await api.history(sessionId, cursor);
			if (session.getState().application?.sessionId !== sessionId) return;
			setHistory((current) => current && addHistoryPage(current, page, cursor));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}
	return (
		<section className="conversation-history" aria-label="Earlier conversation">
			{history?.hasMore !== false && (
				<Button size="sm" loading={loading} onClick={load}>
					Load earlier messages
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
			{history?.hasMore === false && <p className="muted">Beginning of conversation</p>}
			{events.length > 0 && (
				<details open>
					<summary>{history?.messages.length} earlier messages</summary>
					<ol className="activity-feed">
						{events.map((event) => (
							<li key={event.id}>
								<ResultCard event={event} />
							</li>
						))}
					</ol>
				</details>
			)}
		</section>
	);
}
