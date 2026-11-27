import type { ApplicationSnapshot, UiState } from "@octocodeai/octocode-contracts";
import { activity, type ActivityTone } from "@octocodeai/octocode-projections";
import { jobPhaseOf, jobWords } from "./phase-words.ts";

/** The badge colour of each activity tone: green working, yellow waiting for you, red failed, neutral idle. */
export const ACTIVITY_BADGE_TONE = {
	working: "success",
	waiting: "warning",
	error: "danger",
	idle: "neutral",
} as const satisfies Readonly<Record<ActivityTone, "success" | "warning" | "danger" | "neutral">>;

/** The badge's words for each activity word the shared light uses (`activity`). */
const BADGE_WORDS: Readonly<Record<string, string>> = {
	"needs you": "Waiting for you",
	compacting: "Compacting",
	retrying: "Retrying",
	"not answering": "Not answering",
	working: "Running",
	failed: "Failed",
	stopped: "Stopped",
};

/**
 * The session panel's badge: the shared activity light (`activity`, which the terminal footer reads too), its state's
 * shape and the panel's words; a job that goes on without a run names what it waits on. Nothing while the session is
 * idle or done.
 */
export function sessionBadge(
	snapshot: Pick<ApplicationSnapshot, "streaming" | "status" | "awaiting" | "phase"> | undefined,
): { state: UiState; tone: ActivityTone; label: string } | undefined {
	const shown = activity(snapshot);
	const job = shown.tone !== "waiting" && !snapshot?.streaming ? jobPhaseOf(snapshot?.phase) : undefined;
	if (shown.tone === "idle" && !job) return undefined;
	const label = job && (!snapshot?.status || snapshot.status === "idle") ? jobWords(job, Date.now()) : undefined;
	return { state: shown.state, tone: shown.tone, label: label ?? BADGE_WORDS[shown.label] ?? shown.label };
}
