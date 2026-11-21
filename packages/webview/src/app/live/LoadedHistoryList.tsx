import { useId, useMemo, useRef, useState } from "react";
import { SearchField } from "../ui/fields.tsx";
import { Button } from "../ui/primitives.tsx";
import type { FeedEvent } from "@octocodeai/octocode-projections";
import { activityCard } from "./model.ts";
import { ResultCard } from "./ResultCard.tsx";

const PAGE_SIZE = 100;

/** Loaded records remain searchable and reachable; only one page mounts rich cards. */
export function LoadedHistoryList({
	events,
	loadRevision,
	label,
}: {
	events: readonly FeedEvent[];
	loadRevision: number;
	label: string;
}) {
	const listId = useId();
	const [query, setQuery] = useState("");
	const [position, setPosition] = useState<{ revision: number; anchor?: number; offset: number }>({
		revision: loadRevision,
		offset: 0,
	});
	const beforeSearch = useRef(position);
	const needle = query.trim().toLocaleLowerCase();
	const hasQuery = Boolean(needle);
	const searchable = useMemo(
		() =>
			hasQuery
				? events.map((event) => {
						const card = activityCard(event);
						return {
							event,
							text: [
								event.text,
								event.hint,
								card.title,
								card.body,
								card.goal,
								...card.files,
								event.message?.text,
								event.activity?.text,
								event.tool?.text,
								...(event.tools ?? []).map((tool) => tool.text),
							]
								.filter(Boolean)
								.join("\n")
								.toLocaleLowerCase(),
						};
					})
				: [],
		[events, hasQuery],
	);
	const filtered = useMemo(
		() => (needle ? searchable.filter((row) => row.text.includes(needle)).map((row) => row.event) : events),
		[events, searchable, needle],
	);
	const found =
		position.revision === loadRevision && position.anchor !== undefined
			? filtered.findIndex((event) => event.id === position.anchor)
			: -1;
	const start =
		position.revision !== loadRevision
			? 0
			: found >= 0
				? found
				: Math.floor(Math.min(position.offset, Math.max(0, filtered.length - 1)) / PAGE_SIZE) * PAGE_SIZE;
	const shown = filtered.slice(start, start + PAGE_SIZE);
	const anchor = filtered[start]?.id;
	if (position.revision !== loadRevision || position.anchor !== anchor || position.offset !== start)
		setPosition({ revision: loadRevision, anchor, offset: start });
	const move = (offset: number) => setPosition({ revision: loadRevision, anchor: filtered[offset]?.id, offset });
	return (
		<div>
			<SearchField
				label={`Search ${label}`}
				placeholder="Search loaded history"
				value={query}
				onChange={(event) => {
					const next = event.target.value;
					if (!query.trim() && next.trim()) beforeSearch.current = position;
					setQuery(next);
					setPosition(
						next.trim() ? { revision: loadRevision, offset: 0 } : { ...beforeSearch.current, revision: loadRevision },
					);
				}}
			/>
			<nav className="view-actions" aria-label={`${label} pages`}>
				<Button
					size="sm"
					aria-controls={listId}
					disabled={start === 0}
					onClick={() => move(Math.max(0, start - PAGE_SIZE))}
				>
					Older loaded
				</Button>
				<output className="muted">
					{filtered.length
						? `${start + 1}–${start + shown.length} of ${filtered.length}${needle ? " matches" : " loaded"}`
						: needle
							? "No matches"
							: "No loaded entries"}
					{needle ? ` (${events.length} loaded)` : ""}
				</output>
				<Button
					size="sm"
					aria-controls={listId}
					disabled={start + shown.length >= filtered.length}
					onClick={() => move(start + PAGE_SIZE)}
				>
					Newer loaded
				</Button>
			</nav>
			<ol id={listId} className="activity-feed" start={start + 1} aria-label={label}>
				{shown.map((event) => (
					<li key={event.id}>
						<ResultCard event={event} />
					</li>
				))}
			</ol>
		</div>
	);
}
