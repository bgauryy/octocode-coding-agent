import type { ApplicationActivity } from "@octocodeai/octocode-contracts";
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { ApplicationProjection, type FeedEvent } from "@octocodeai/octocode-projections";
import { LoadedHistoryList } from "./LoadedHistoryList.tsx";
import { useLive } from "./session.tsx";

/** Activity cursors are independent of message history, so notices cannot hide older conversation pages. */
export function ActivityHistory({ sessionId }: { sessionId: string }) {
	const { api, session } = useLive();
	const hasMoreLive = useStore(session, (state) => state.application?.hasMoreActivities ?? false);
	const activityBefore = useStore(session, (state) => state.application?.activityBefore);
	const [history, setHistory] = useState<{ activities: ApplicationActivity[]; before?: string; hasMore: boolean }>();
	const [events, setEvents] = useState<FeedEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadRevision, setLoadRevision] = useState(0);
	const [error, setError] = useState("");
	const projection = useRef(new ApplicationProjection());
	const hasMore = history?.hasMore ?? hasMoreLive;
	async function load() {
		setLoading(true);
		setError("");
		try {
			const page = await api.history(sessionId, undefined, history?.before ?? activityBefore);
			const snapshot = session.getState().application;
			if (snapshot?.sessionId !== sessionId) return;
			const activities = [
				...new Map(
					[...(page.activities ?? []), ...(history?.activities ?? [])].map((activity) => [activity.id, activity]),
				).values(),
			];
			setHistory({ activities, before: page.activityBefore, hasMore: page.hasMoreActivities ?? false });
			const known = new Set((history?.activities ?? []).map((activity) => activity.id));
			if (page.activities?.some((activity) => !known.has(activity.id))) setLoadRevision((revision) => revision + 1);
			setEvents(
				projection.current.update(
					{
						...snapshot,
						messages: [],
						tools: [],
						errors: [],
						activities,
						streaming: false,
					},
					0,
				),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}
	if (!hasMore && !history && !error) return null;
	return (
		<section className="conversation-history" aria-label="Earlier session updates">
			{hasMore && (
				<Button size="sm" loading={loading} onClick={load}>
					Load earlier session updates
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
			{events.length > 0 && (
				<details open>
					<summary>{events.length} earlier session updates</summary>
					<LoadedHistoryList events={events} loadRevision={loadRevision} label="Loaded session updates" />
				</details>
			)}
		</section>
	);
}
