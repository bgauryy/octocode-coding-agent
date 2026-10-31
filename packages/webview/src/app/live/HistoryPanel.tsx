import type { ApplicationHistory, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "../model/format.ts";
import { Button } from "../ui/primitives.tsx";
import { ApplicationProjection, type FeedEvent } from "./application-projection.ts";
import { ActivityHistory } from "./ActivityHistory.tsx";
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
	const [history, setHistory] = useState<ApplicationHistory>();
	const [events, setEvents] = useState<FeedEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const projection = useRef(new ApplicationProjection());
	async function load() {
		setLoading(true);
		setError("");
		try {
			const page = await api.history(snapshot.sessionId, history?.before ?? snapshot.messages[0]?.id);
			if (session.getState().application?.sessionId !== snapshot.sessionId) return;
			const next: ApplicationHistory = {
				...page,
				messages: [
					...new Map([...page.messages, ...(history?.messages ?? [])].map((message) => [message.id, message])).values(),
				],
				tools: [...new Map([...page.tools, ...(history?.tools ?? [])].map((tool) => [tool.toolCallId, tool])).values()],
			};
			setHistory(next);
			setEvents(
				projection.current
					.update(
						{ ...snapshot, messages: next.messages, tools: next.tools, streaming: false, errors: [], activities: [] },
						0,
					)
					.filter((event) => !event.embedded),
			);
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
