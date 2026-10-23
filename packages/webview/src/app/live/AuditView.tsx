import type { BacklogAudit } from "@octocodeai/octocode-contacts/snapshot";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewProps } from "../extension.ts";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import { errorMessage } from "../model/format.ts";
import { HistoryIcon } from "../ui/icons.tsx";
import { Button, EmptyState } from "../ui/primitives.tsx";
import { AuditRows } from "./ItemPanels.tsx";
import { useLive } from "./session.tsx";

interface Page {
	/** Server pages, oldest first within each page; each renders newest first. */
	pages: BacklogAudit[][];
	before?: number;
	loading: boolean;
	error: string;
}

/** Change history, newest first, including deleted items; older pages load on request. */
export function AuditView({ params }: ViewProps) {
	const { api } = useLive();
	const backlogId = params.backlogId;
	const [page, setPage] = useState<Page>({ pages: [], loading: true, error: "" });
	/** Aborted when the filter changes, so no page of the previous filter, first or older, lands in the new list. */
	const filter = useRef<AbortController>(undefined);

	const load = useCallback(
		async (before: number | undefined, signal: AbortSignal | undefined) => {
			setPage((current) => ({ ...current, loading: true, error: "" }));
			try {
				const result = await api.audit({ before, backlogId }, signal);
				if (signal?.aborted) return;
				setPage((current) => ({
					pages: [...current.pages, result.events],
					before: result.before,
					loading: false,
					error: "",
				}));
			} catch (error) {
				if (signal?.aborted) return;
				setPage((current) => ({ ...current, loading: false, error: errorMessage(error) }));
			}
		},
		[api, backlogId],
	);
	useEffect(() => {
		const controller = new AbortController();
		filter.current = controller;
		setPage({ pages: [], loading: true, error: "" });
		void load(undefined, controller.signal);
		return () => controller.abort();
	}, [load]);

	return (
		<div className="view audit-view">
			<div className="view-heading">
				<h2>{backlogId ? `Audit for ${backlogId}` : "Workspace audit"}</h2>
				<p className="muted">
					Change history, including deleted items. {backlogId && <a href="#audit">Show the whole workspace</a>}
				</p>
			</div>
			{page.loading && !page.pages.length && <ListSkeleton label="Loading audit history" rows={4} />}
			{page.pages.map((events) => (
				<AuditRows key={events[0]?.id ?? "empty"} events={events} />
			))}
			{!page.loading && !page.error && !page.pages.some((events) => events.length) && (
				<EmptyState icon={<HistoryIcon size={20} />} title="No changes recorded yet" />
			)}
			{page.error && (
				<p className="callout tone-danger" role="alert">
					{page.error}
				</p>
			)}
			{page.before !== undefined && (
				<Button loading={page.loading} onClick={() => load(page.before, filter.current?.signal)}>
					Load older events
				</Button>
			)}
		</div>
	);
}
