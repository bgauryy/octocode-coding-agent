import { createStore, type StoreApi } from "zustand/vanilla";
import type {
	ApplicationActivity,
	ApplicationAwaiting,
	ApplicationError,
	ApplicationEvent,
	ApplicationMessage,
	ApplicationPhase,
	ApplicationReceipt,
	ApplicationTool,
	ApplicationSnapshot,
} from "@octocodeai/octocode-contracts";

/** Host-owned interface data. Engine context and resource handles stay with their execution owners. */
export interface ApplicationRuntimeState {
	revision: number;
	sessionId: string;
	model?: ApplicationSnapshot["model"];
	messages: ReadonlyMap<string, ApplicationMessage>;
	tools: ReadonlyMap<string, ApplicationTool>;
	activities: ReadonlyMap<string, ApplicationActivity>;
	runId: string | undefined;
	streaming: boolean;
	status: "idle" | "compacting" | "retrying";
	/** The blocking dialog the run waits on, until it closes. */
	awaiting?: ApplicationAwaiting;
	/** What the session is doing, as the host last published it; undefined before the first publication. */
	phase?: ApplicationPhase;
	/** While `phase` is not terminal: when its job started (ms since the epoch). */
	jobStartedAt?: number;
	steering: string[];
	followUp: string[];
	errors: ApplicationError[];
	receipts: ReadonlyMap<string, { fingerprint: string; receipt: ApplicationReceipt }>;
}

export type ApplicationStateStore = StoreApi<ApplicationRuntimeState>;

/** Read-only view of the state store; structurally a `StateSource` of the terminal UI library. */
export interface ApplicationStateSource {
	getState(): ApplicationRuntimeState;
	/** Calls `listener` after each change; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

export function initialApplicationState(sessionId: string): ApplicationRuntimeState {
	return {
		revision: 0,
		sessionId,
		messages: new Map(),
		tools: new Map(),
		activities: new Map(),
		runId: undefined,
		streaming: false,
		status: "idle",
		steering: [],
		followUp: [],
		errors: [],
		receipts: new Map(),
	};
}

export function createApplicationState(sessionId = ""): ApplicationStateStore {
	return createStore<ApplicationRuntimeState>()(() => initialApplicationState(sessionId));
}

/** Apply lifecycle facts before notifying either local or serialized consumers. */
export function acceptApplicationEvent(store: ApplicationStateStore, event: ApplicationEvent): void {
	switch (event.type) {
		case "session.model":
			store.setState({ model: event.model ? structuredClone(event.model) : undefined });
			break;
		case "run.started":
			store.setState({ runId: event.runId, streaming: true });
			break;
		case "run.settled":
			store.setState({ runId: undefined, streaming: false });
			break;
		case "session.status":
			store.setState({ status: event.status });
			break;
		case "session.awaiting":
			store.setState({ awaiting: event.awaiting ? { ...event.awaiting } : undefined });
			break;
		case "session.phase":
			store.setState({ phase: structuredClone(event.phase), jobStartedAt: event.jobStartedAt });
			break;
		case "queue.changed":
			store.setState({ steering: [...event.steering], followUp: [...event.followUp] });
			break;
		case "application.error":
			store.setState(({ errors }) => ({
				errors: [...errors.filter((item) => item.id !== event.id), event].slice(-10),
			}));
			break;
		case "command.receipt": {
			const previous = store.getState().receipts.get(event.receipt.id);
			if (previous)
				store.setState(({ receipts }) => ({
					receipts: new Map(receipts).set(event.receipt.id, { ...previous, receipt: { ...event.receipt } }),
				}));
			break;
		}
		default:
			// Transcript, tool, activity and reset events carry no lifecycle state.
			break;
	}
}

const RECEIPT_LIMIT = 1000;
const RECEIPT_KEEP = 500;

/**
 * Make room for one more command receipt. At the limit the oldest settled receipts go (they only serve repeated-id
 * idempotency) until `RECEIPT_KEEP` remain; receipts of commands still running are never dropped.
 */
export function reserveReceipt(store: ApplicationStateStore): void {
	const { receipts } = store.getState();
	if (receipts.size < RECEIPT_LIMIT) return;
	const kept = new Map(receipts);
	for (const [id, { receipt }] of receipts) {
		if (kept.size <= RECEIPT_KEEP) break;
		if (receipt.status !== "accepted") kept.delete(id);
	}
	if (kept.size >= RECEIPT_LIMIT)
		throw new Error("Command receipt capacity reached; too many commands are still running");
	store.setState({ receipts: kept });
}
