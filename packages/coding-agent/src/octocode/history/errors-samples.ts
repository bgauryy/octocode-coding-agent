import { formatAnchor } from "@octocodeai/octocode-contracts/evidence";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { transcripts, type Db } from "../../../../db/src/api.ts";
import { emittedCall } from "./transcript-text.ts";

/** One error result shown as an example of its group, with what opens the call that failed. */
export interface Sample {
	session: string;
	at: string;
	call: string;
	text: string;
	entry?: string;
	callEntry?: string;
	/** The emitted call's tool name and arguments, bounded (`emittedCall`). */
	emitted?: string;
}

/** The `get` ids that open a sample's emitted call and its result, when the transcript recorded them. */
export function sampleAnchors({ session, callEntry, entry }: Sample): string[] {
	const open = (entryId: string, what: string) =>
		`${formatAnchor({ kind: "transcript", sessionId: session, entryId })} (${what})`;
	const ids = [...(callEntry ? [open(callEntry, "call")] : []), ...(entry ? [open(entry, "result")] : [])];
	return ids.length ? [`  get id: ${ids.join(" · ")}`] : [];
}

/** Reads the emitted call (tool name and bounded arguments) of each sample: one indexed lookup per shown sample, not a second scan. */
export function attachEmitted(db: Db, samples: readonly Sample[]): void {
	for (const sample of samples) {
		const line = sample.callEntry ? transcripts.entry(db, sample.session, sample.callEntry) : undefined;
		if (!line) continue;
		const emitted = emittedCall(JSON.parse(line), sample.call);
		if (emitted) sample.emitted = redactSecrets(emitted);
	}
}
