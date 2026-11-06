import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import {
	REPORT_KINDS,
	type BacklogCommand,
	type BacklogMutation,
	type ReportFile,
	type ReportSummary,
	type ReportsIndex,
	WORKSPACE_ROUTES,
} from "@octocodeai/octocode-contracts/protocol";
import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { BacklogAudit, Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type {
	WorkspaceCommand,
	WorkspaceEvent,
	WorkspaceReceipt,
	WorkspaceSnapshot,
} from "@octocodeai/octocode-contracts/workspace";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createWorkspaceStore } from "../../state.ts";
import { bearer } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { scopedRoute } from "../../scope.ts";
import { BrowserConnection } from "../../transport.ts";
import { createApplicationApi } from "./application-api.ts";
import { createDocsApi } from "./docs-api.ts";
import type { BacklogStore } from "../extension.ts";
import { stamp } from "../model/format.ts";
import { Spinner } from "../ui/primitives.tsx";
import {
	ApplicationProjection,
	type ConnectionTone,
	connectionTone,
	EventInterner,
	latestProgress,
	mergeEvents,
	settleToolStarts,
} from "./model.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

interface SessionState {
	historyRevision: number;
	status: { tone: ConnectionTone; text: string };
	application: ApplicationSnapshot | undefined;
	/** The active run and when this view first saw it, for elapsed and "thought for" times. */
	run: { id: string; startedAt: number } | undefined;
	connection: BrowserConnection | undefined;
}

/** Authenticated calls to the local host; the host stays the authority for every change. */
function createApi(access: string) {
	const authorization = bearer(access);
	const headers = { ...authorization, "Content-Type": "application/json" };
	return {
		...createApplicationApi(access),
		...createDocsApi(access),
		backlogs: async () =>
			requestJson<Snapshot>(scopedRoute(WORKSPACE_ROUTES.backlogs), { headers }, "Could not load the board"),
		mutate: async (payload: BacklogMutation) =>
			requestJson<{ item: Pick<SnapshotItem, "ref" | "version"> }>(
				scopedRoute(WORKSPACE_ROUTES.backlogs),
				{ method: "POST", headers, body: JSON.stringify(payload) },
				"Could not save",
			),
		/** One hierarchy edit; the host applies it as the user and answers with the store's one-line error on refusal. */
		backlogCommand: async (payload: BacklogCommand) =>
			requestJson<{ item?: Pick<SnapshotItem, "ref" | "version">; task?: BacklogTask }>(
				scopedRoute(WORKSPACE_ROUTES.backlogs),
				{ method: "POST", headers, body: JSON.stringify(payload) },
				"Could not save",
			),
		command: async (payload: WorkspaceCommand): Promise<WorkspaceReceipt> => {
			const result = await requestJson<{ receipt?: unknown }>(
				scopedRoute(WORKSPACE_ROUTES.workspace),
				{ method: "POST", headers, body: JSON.stringify(payload) },
				"Request failed",
			);
			const receipt = result?.receipt as Partial<WorkspaceReceipt> | undefined;
			if (
				!receipt ||
				receipt.id !== payload.id ||
				receipt.action !== payload.action ||
				receipt.backlogId !== payload.backlogId ||
				!["pending", "accepted", "failed"].includes(receipt.status ?? "") ||
				typeof receipt.at !== "number" ||
				!Number.isFinite(receipt.at) ||
				typeof receipt.message !== "string"
			)
				throw new Error("Invalid workspace command receipt");
			return receipt as WorkspaceReceipt;
		},
		audit: async (params: { before?: number; backlogId?: string }, signal?: AbortSignal) =>
			requestJson<{ events: BacklogAudit[]; before?: number }>(
				`${scopedRoute(WORKSPACE_ROUTES.audit)}?${new URLSearchParams({
					...(params.before ? { before: String(params.before) } : {}),
					...(params.backlogId ? { backlogId: params.backlogId } : {}),
				})}`,
				{ headers: authorization, signal },
				"Could not load audit",
			),
		reports: async (signal?: AbortSignal): Promise<ReportsIndex> => {
			const value = await requestJson(
				scopedRoute(WORKSPACE_ROUTES.reports),
				{ headers: authorization, signal },
				"Could not load reports",
			);
			if (!isRecord(value) || !Array.isArray(value.reports) || !value.reports.every(isReportSummary))
				throw new Error("Invalid reports response");
			return value as unknown as ReportsIndex;
		},
		reportFile: async (
			id: string,
			kind: ReportSummary["kind"],
			file: string,
			signal?: AbortSignal,
		): Promise<ReportFile> => {
			const value = await requestJson(
				`${scopedRoute(WORKSPACE_ROUTES.reports)}/file?${new URLSearchParams({ id, kind, name: file })}`,
				{
					headers: authorization,
					signal,
				},
				"Could not load the report",
			);
			if (
				!isRecord(value) ||
				value.id !== id ||
				value.kind !== kind ||
				value.file !== file ||
				typeof value.markdown !== "string"
			)
				throw new Error("Invalid report file response");
			return value as unknown as ReportFile;
		},
	};
}

function isReportSummary(value: unknown): value is ReportSummary {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.kind === "string" &&
		REPORT_KINDS.includes(value.kind as ReportSummary["kind"]) &&
		typeof value.title === "string" &&
		typeof value.updated === "string" &&
		Array.isArray(value.files) &&
		value.files.every((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.bytes === "number")
	);
}

type LiveApi = ReturnType<typeof createApi>;

interface LiveSession {
	access: string;
	backlog: BacklogStore;
	workspace: ReturnType<typeof createWorkspaceStore>;
	session: StoreApi<SessionState>;
	api: LiveApi;
	/** Reload the board after a change this tab made, without waiting for the push. */
	refresh: () => Promise<void>;
}

const LiveContext = createContext<LiveSession | null>(null);
export function useLive(): LiveSession {
	const live = useContext(LiveContext);
	if (!live) throw new Error("Live controls need a LiveProvider.");
	return live;
}

/**
 * Coalesce bursts (token deltas, tool progress) into one store update per frame. Browsers pause animation frames in
 * hidden tabs, so a timeout races the frame: whichever fires first publishes, and hidden tabs keep updating slowly.
 */
function frameScheduler(run: () => void, fallbackMs = 100) {
	let frame: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => {
		if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
		clearTimeout(timer);
		frame = undefined;
		timer = undefined;
	};
	const fire = () => {
		cancel();
		run();
	};
	return {
		schedule() {
			if (timer !== undefined) return;
			if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(fire);
			timer = setTimeout(fire, fallbackMs);
		},
		cancel,
	};
}

/**
 * Owns the connection for as long as the page is mounted. Workspace snapshots and the application stream merge into
 * one ordered feed; closing the page only disconnects and never sends an abort.
 */
export function LiveProvider({
	access,
	backlog,
	children,
}: {
	access: string;
	backlog: BacklogStore;
	children: ReactNode;
}) {
	const live = useMemo<LiveSession>(() => {
		const api = createApi(access);
		const session = createStore<SessionState>()(() => ({
			status: { tone: "connecting", text: "Connecting…" },
			historyRevision: 0,
			application: undefined,
			run: undefined,
			connection: undefined,
		}));
		return {
			access,
			backlog,
			api,
			workspace: createWorkspaceStore(),
			session,
			refresh: async () => {
				const connection = session.getState().connection;
				const previous = backlog.getState().snapshot;
				const snapshot = await api.backlogs();
				if (!connection || session.getState().connection !== connection)
					throw new Error("Workspace changed while refreshing. Reopen the board to see its current state.");
				const current = backlog.getState().snapshot;
				// A slower HTTP read must not rewind a newer push or a later refresh.
				if (current === previous || snapshot.generatedAt > current.generatedAt)
					backlog.getState().setSnapshot(snapshot);
			},
		};
	}, [access, backlog]);

	useEffect(() => {
		const projection = new ApplicationProjection();
		const interner = new EventInterner();
		let domain: WorkspaceSnapshot = { sessionId: "", agents: [], traffic: [], events: [], receipts: [] };
		let pendingDomain: WorkspaceSnapshot | undefined;
		let projected: WorkspaceEvent[] = [];
		const publishNow = (sessionId: string | undefined) => {
			const merged = mergeEvents(domain, projected, sessionId);
			live.workspace
				.getState()
				.accept({ ...merged, events: interner.intern(latestProgress(settleToolStarts(merged.events))) });
		};
		const publish = frameScheduler(() => publishNow(live.session.getState().application?.sessionId));
		const connection = new BrowserConnection(access, {
			workspace: (snapshot) => {
				const applicationSessionId = live.session.getState().application?.sessionId;
				if (applicationSessionId && snapshot.sessionId !== applicationSessionId) {
					// A fresh connection sends workspace before application; hold it until the application confirms
					// the switch. A delayed packet for an old session must not replace the visible new session.
					pendingDomain = snapshot;
					return;
				}
				pendingDomain = undefined;
				domain = snapshot;
				publish.schedule();
			},
			backlogs: (snapshot) => {
				live.backlog.getState().setSnapshot(snapshot);
				live.session.setState({
					status: { tone: "live", text: `Live · updated ${stamp(snapshot.generatedAt).slice(11)}` },
				});
			},
			status: (text) => live.session.setState({ status: { tone: connectionTone(text), text } }),
			application: (stream, frame) => {
				if (frame.type === "snapshot" || (frame.type === "event" && frame.event.type === "session.reset"))
					live.session.setState((state) => ({ historyRevision: state.historyRevision + 1 }));
				const application = stream.snapshot;
				projected = projection.update(application, stream.at);
				if (application && domain.sessionId !== application.sessionId) {
					domain =
						pendingDomain?.sessionId === application.sessionId
							? pendingDomain
							: { sessionId: application.sessionId, agents: [], traffic: [], events: [], receipts: [] };
					pendingDomain = undefined;
				}
				if (application && live.workspace.getState().snapshot?.sessionId !== application.sessionId) {
					// Clear the previous session's drafts before its replacement composer becomes available.
					// Delaying this reset until the next frame can erase text typed into that new composer.
					publish.cancel();
					publishNow(application.sessionId);
				}
				live.session.setState({ application, run: projection.run });
				publish.schedule();
			},
		});
		live.session.setState({ connection });
		connection.open();
		return () => {
			publish.cancel();
			connection.close();
			live.session.setState({ connection: undefined });
		};
	}, [live, access]);

	return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function ConnectionStatus() {
	const status = useStore(useLive().session, (state) => state.status);
	return (
		<output id="connection-status" className={`connection tone-${status.tone}`}>
			{status.tone === "connecting" ? <Spinner size={10} /> : <span className="live-dot" aria-hidden="true" />}
			{status.text}
		</output>
	);
}
