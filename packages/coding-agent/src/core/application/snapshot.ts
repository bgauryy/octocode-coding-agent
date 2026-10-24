import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { ApplicationRuntimeState } from "./state.ts";
import type { ApplicationTranscript } from "./transcript.ts";
import type { ApplicationActivities } from "./service/activities.ts";
import { cloneDisplay } from "./normalize.ts";

/** The same bounded read model for local subscribers and serialized connections. */
export function applicationSnapshot(
	state: ApplicationRuntimeState,
	transcript: ApplicationTranscript,
	activities: ApplicationActivities,
): ApplicationSnapshot {
	return {
		sessionId: state.sessionId,
		...transcript.window(),
		...activities.window(),
		errors: cloneDisplay(state.errors),
		status: state.status,
		...(state.runId === undefined ? {} : { runId: state.runId }),
		streaming: state.streaming,
		steering: [...state.steering],
		followUp: [...state.followUp],
		receipts: [...state.receipts.values()].slice(-20).map(({ receipt }) => ({
			...receipt,
			...(receipt.message ? { message: receipt.message.slice(0, 1000) } : {}),
		})),
		capabilities: ["prompt", "steer", "followUp", "abort"],
	};
}
