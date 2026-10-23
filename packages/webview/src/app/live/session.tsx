import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { type BacklogMutation, WORKSPACE_ROUTES } from "@octocodeai/octocode-contacts/protocol";
import type { BacklogAudit, Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import type {
	WorkspaceCommand,
	WorkspaceEvent,
	WorkspaceReceipt,
	WorkspaceSnapshot,
} from "@octocodeai/octocode-contacts/workspace";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createWorkspaceStore } from "../../state.ts";
import { BrowserConnection } from "../../transport.ts";
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

interface SessionState {
	status: { tone: ConnectionTone; text: string };
	application: ApplicationSnapshot | undefined;
	/** The active run and when this view first saw it, for elapsed and "thought for" times. */
	run: { id: string; startedAt: number } | undefined;
	connection: BrowserConnection | undefined;
}

/** Authenticated calls to the local host; the host stays the authority for every change. */
function createApi(access: string) {
	const headers = { Authorization: `Bearer ${access}`, "Content-Type": "application/json" };
	async function read<T>(response: Response, fallback: string): Promise<T> {
		const result = await response.json();
		if (!response.ok) throw new Error(result?.error || fallback);
		return result as T;
	}
	return {
		backlogs: async () =>
			read<Snapshot>(await fetch(WORKSPACE_ROUTES.backlogs, { headers }), "Could not load the board"),
		mutate: async (payload: BacklogMutation) =>
			read<{ item: SnapshotItem }>(
				await fetch(WORKSPACE_ROUTES.backlogs, { method: "POST", headers, body: JSON.stringify(payload) }),
				"Could not save",
			),
		command: async (payload: WorkspaceCommand) =>
			(
				await read<{ receipt: WorkspaceReceipt }>(
					await fetch(WORKSPACE_ROUTES.workspace, { method: "POST", headers, body: JSON.stringify(payload) }),
					"Request failed",
				)
			).receipt,
		audit: async (params: { before?: number; backlogId?: string }, signal?: AbortSignal) =>
			read<{ events: BacklogAudit[]; before?: number }>(
				await fetch(
					`${WORKSPACE_ROUTES.audit}?${new URLSearchParams({
						...(params.before ? { before: String(params.before) } : {}),
						...(params.backlogId ? { backlogId: params.backlogId } : {}),
					})}`,
					{ headers: { Authorization: headers.Authorization }, signal },
				),
				"Could not load audit",
			),
	};
}
type LiveApi = ReturnType<typeof createApi>;

interface LiveSession {
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
		frame = timer = undefined;
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
	const [live] = useState<LiveSession>(() => {
		const api = createApi(access);
		return {
			backlog,
			api,
			workspace: createWorkspaceStore(),
			session: createStore<SessionState>()(() => ({
				status: { tone: "connecting", text: "Connecting…" },
				application: undefined,
				run: undefined,
				connection: undefined,
			})),
			refresh: async () => backlog.getState().setSnapshot(await api.backlogs()),
		};
	});

	useEffect(() => {
		const projection = new ApplicationProjection();
		const interner = new EventInterner();
		let domain: WorkspaceSnapshot = { sessionId: "", agents: [], traffic: [], events: [], receipts: [] };
		let pendingDomain: WorkspaceSnapshot | undefined;
		let projected: WorkspaceEvent[] = [];
		const publish = frameScheduler(() => {
			const merged = mergeEvents(domain, projected, live.session.getState().application?.sessionId);
			live.workspace
				.getState()
				.accept({ ...merged, events: interner.intern(latestProgress(settleToolStarts(merged.events))) });
		});
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
			application: (stream) => {
				const application = stream.snapshot;
				const previousSessionId = live.session.getState().application?.sessionId;
				projected = projection.update(application, stream.at);
				if (
					application &&
					domain.sessionId !== application.sessionId &&
					(!domain.sessionId || (previousSessionId && previousSessionId !== application.sessionId))
				) {
					domain =
						pendingDomain?.sessionId === application.sessionId
							? pendingDomain
							: { sessionId: application.sessionId, agents: [], traffic: [], events: [], receipts: [] };
					pendingDomain = undefined;
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
