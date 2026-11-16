import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { redactData, redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { saveContentCopy, saveFullOutput } from "../../shared/spill.ts";
import { capChars } from "../../shared/util.ts";
import { ERR, MAX_FRAME_BYTES, RpcError } from "../protocol.ts";

const RESULT_MAX_CHARS = 64_000;

/**
 * Model text for an event or a history entry: credential-looking spans redacted first (so a secret that straddles the
 * limit is never left half-visible), then, over `RESULT_MAX_CHARS`, cut with the whole redacted text saved to a file
 * the note names (or the note says it could not be saved).
 */
export function boundedText(text: string): string {
	if (text.length <= RESULT_MAX_CHARS) return redactSecrets(text);
	// The same answer reaches `message.delta`, `message` and `agent.end` in a row: a long one is redacted and saved once,
	// not once per channel (a 50 MB reply held the main thread for seconds each time). Remembered by a hash of its text,
	// so the text itself is not kept.
	const key = sha256(text);
	if (last?.key === key) return last.bounded;
	const safe = redactSecrets(text);
	if (safe.length <= RESULT_MAX_CHARS) return safe;
	// The file is named by its content, so the channels and the history share one file.
	const copy = saveContentCopy(safe, "api message");
	const bounded = capChars(
		safe,
		RESULT_MAX_CHARS,
		copy ? `the whole text is in ${copy}` : "the whole text could not be saved",
	);
	// Only a saved copy is reused: a failed save is tried again next time.
	last = copy ? { key, bounded } : undefined;
	return bounded;
}

/** The last long text `boundedText` bounded, by its hash, and what it returned. */
let last: { key: string; bounded: string } | undefined;

export function boundedExternal(value: unknown): unknown {
	const safe = redactData(value);
	const text = JSON.stringify(safe);
	const bytes = Buffer.byteLength(text);
	if (bytes <= MAX_FRAME_BYTES / 2) return safe;
	const file = saveFullOutput(text, "external-api-result");
	if (!file)
		throw new RpcError(
			ERR.unavailable,
			"Complete external evidence could not be saved; execution may already have completed",
			{ execution: "uncertain", bytes },
		);
	return {
		fullOutput: { path: file, bytes, format: "json" },
		notice: "Complete redacted result saved on the Octocode host; read this file before acting on the result.",
	};
}
