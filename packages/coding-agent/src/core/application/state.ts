import { createStore, type StoreApi } from "zustand/vanilla";
import type {
	ApplicationActivity,
	ApplicationError,
	ApplicationEvent,
	ApplicationMessage,
	ApplicationReceipt,
	ApplicationTool,
} from "@octocodeai/octocode-contacts";

/** Host-owned interface data. Engine context and resource handles stay with their execution owners. */
export interface ApplicationRuntimeState {
	revision: number;
	sessionId: string;
	messages: ReadonlyMap<string, ApplicationMessage>;
	tools: ReadonlyMap<string, ApplicationTool>;
	activities: ReadonlyMap<string, ApplicationActivity>;
	runId: string | undefined;
	streaming: boolean;
	status: "idle" | "compacting" | "retrying";
	steering: string[];
	followUp: string[];
	errors: ApplicationError[];
	receipts: ReadonlyMap<string, { fingerprint: string; receipt: ApplicationReceipt }>;
}

export type ApplicationStateStore = StoreApi<ApplicationRuntimeState>;

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
		case "run.started":
			store.setState({ runId: event.runId, streaming: true });
			break;
		case "run.settled":
			store.setState({ runId: undefined, streaming: false });
			break;
		case "session.status":
			store.setState({ status: event.status });
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
	}
}
