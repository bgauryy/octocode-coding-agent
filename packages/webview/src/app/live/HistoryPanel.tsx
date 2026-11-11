import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { ApplicationProjection } from "./application-projection.ts";
import { ActivityHistory } from "./ActivityHistory.tsx";
import { addHistoryPage, type LoadedHistory, requestHistory, retainEvicted } from "./history-window.ts";
import { ResultCard } from "./ResultCard.tsx";
import { useLive } from "./session.tsx";

const NO_MESSAGES: readonly ApplicationMessage[] = [];

/**
 * History pages are explicit reads; they never replace or rewind the live event cursor. Each part selects only the
 * fields it reads, so a status or model change does not re-render the pages.
 */
export function HistoryPanel() {
	const store = useLive().session;
	const sessionId = useStore(store, (state) => state.application?.sessionId);
	const revision = useStore(store, (state) => state.historyRevision);
	return sessionId ? (
		<div key={`${sessionId}:${revision}`}>
			<HistoryPages sessionId={sessionId} />
			<ActivityHistory sessionId={sessionId} />
		</div>
	) : null;
}

function HistoryPages({ sessionId }: { sessionId: string }) {
	const { api, session } = useLive();
	const messages = useStore(session, (state) => state.application?.messages ?? NO_MESSAGES);
	const tools = useStore(session, (state) => state.application?.tools);
	const [history, setHistory] = useState<LoadedHistory>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	// The projection is an incremental row cache; one instance lives as long as this history.
	const [projection] = useState(() => new ApplicationProjection());
	const live = useRef({ messages, tools });
	// The live window drops its oldest messages as new ones arrive; once history is shown they move into it before paint.
	useLayoutEffect(() => {
		const previous = live.current;
		if (previous.messages === messages && previous.tools === tools) return;
		const current = { messages, tools };
		live.current = current;
		setHistory((loaded) => loaded && retainEvicted(loaded, previous, current));
	}, [messages, tools]);
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
		const cursor = requestHistory(history, messages[0]?.id).before;
		setHistory((current) => requestHistory(current, messages[0]?.id));
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
