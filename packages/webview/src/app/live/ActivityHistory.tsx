import type { ApplicationActivity, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { useRef, useState } from "react";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { ApplicationProjection, type FeedEvent } from "./application-projection.ts";
import { ResultCard } from "./ResultCard.tsx";
import { useLive } from "./session.tsx";

/** Activity cursors are independent of message history, so notices cannot hide older conversation pages. */
export function ActivityHistory({ snapshot }: { snapshot: ApplicationSnapshot }) {
	const { api, session } = useLive();
	const [history, setHistory] = useState<{ activities: ApplicationActivity[]; before?: string; hasMore: boolean }>();
	const [events, setEvents] = useState<FeedEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const projection = useRef(new ApplicationProjection());
	const hasMore = history?.hasMore ?? snapshot.hasMoreActivities ?? false;
	async function load() {
		setLoading(true);
		setError("");
		try {
			const page = await api.history(snapshot.sessionId, undefined, history?.before ?? snapshot.activityBefore);
			if (session.getState().application?.sessionId !== snapshot.sessionId) return;
			const activities = [
				...new Map(
					[...(page.activities ?? []), ...(history?.activities ?? [])].map((activity) => [activity.id, activity]),
				).values(),
			];
			setHistory({ activities, before: page.activityBefore, hasMore: page.hasMoreActivities ?? false });
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
