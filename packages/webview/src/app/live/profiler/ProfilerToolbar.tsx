import { useState } from "react";
import { span, stamp } from "../../model/format.ts";
import { Button } from "../../ui/primitives.tsx";
import { useLive } from "../session.tsx";
import type { ProfileRange } from "./panel-props.ts";
import { useNow } from "./use-now.ts";

/** Fetch the trace with the page's token and hand it to the browser as a file. */
async function saveTrace(trace: () => Promise<Blob>): Promise<void> {
	const url = URL.createObjectURL(await trace());
	try {
		const link = document.createElement("a");
		link.href = url;
		link.download = "profiler-trace.json";
		link.click();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** `session 3f9a1c1d · started 14:02 · 42m`: the muted line beside the title; the age ticks. */
function SessionMeta({ sessionId, startedAt }: { sessionId: string | undefined; startedAt: number | undefined }) {
	const now = useNow();
	return (
		<span className="pf-meta" title={sessionId}>
			session {sessionId ? sessionId.slice(0, 8) : "…"}
			{startedAt !== undefined && ` · started ${stamp(startedAt).slice(11)} · ${span(now - startedAt)}`}
		</span>
	);
}

/** The slim bar in the heading row: title and session meta on the left, live or paused, range, filter and export on the right. */
export function ProfilerToolbar({
	sessionId,
	startedAt,
	paused,
	held,
	range,
	filter,
	onPause,
	onRange,
	onFilter,
}: {
	sessionId: string | undefined;
	startedAt: number | undefined;
	paused: boolean;
	held: number;
	range: ProfileRange | undefined;
	filter: string;
	onPause: (paused: boolean) => void;
	onRange: (range: ProfileRange | undefined) => void;
	onFilter: (text: string) => void;
}) {
	const { api } = useLive();
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string>();
	const exportTrace = async () => {
		setExporting(true);
		setExportError(undefined);
		try {
			await saveTrace(() => api.profilerTrace());
		} catch (cause) {
			setExportError(cause instanceof Error ? cause.message : "Could not export the trace");
		} finally {
			setExporting(false);
		}
	};
	return (
		<div className="pf-head">
			<h2>Profiler</h2>
			<SessionMeta sessionId={sessionId} startedAt={startedAt} />
			<div className="pf-controls" role="toolbar" aria-label="Profiler controls">
				<Button size="sm" aria-pressed={paused} onClick={() => onPause(!paused)}>
					{paused ? `Paused${held ? ` · ${held} new` : ""} — resume` : "● Live — pause"}
				</Button>
				{range && (
					<Button size="sm" onClick={() => onRange(undefined)} title="Show the whole session again">
						Range {span(range.to - range.from)} — clear
					</Button>
				)}
				<input
					type="search"
					className="pf-filter"
					aria-label="Filter agents, requests, events and findings"
					placeholder="Filter"
					value={filter}
					onChange={(event) => onFilter(event.target.value)}
				/>
				<Button size="sm" disabled={exporting} onClick={() => void exportTrace()}>
					{exporting ? "Exporting…" : "Export trace"}
				</Button>
				{exportError && (
					<span className="pf-error" role="alert">
						{exportError}
					</span>
				)}
			</div>
		</div>
	);
}
