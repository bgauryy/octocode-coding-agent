import { clip, oneLine } from "../shared/text.ts";
import { completionInput } from "./tool-arguments.ts";

/**
 * What a finished `done` tells its holder and the user beyond the item's new state: the completion summary, how it was
 * verified, and the QA outcome (the review's note, or that none ran).
 */
export function doneReply(completion: unknown, qa: string | undefined): string {
	const { summary, verification } = completionInput(completion);
	// The holder usually opens the check with its status (`passed: ran ...`): say it once.
	const check = oneLine(verification.summary);
	const stated = /^(?:passed|failed|not[ _]run|n\/a|not[ _]applicable)\b/i.test(check);
	return [
		`Summary: ${clip(oneLine(summary), 300)}`,
		`Verification: ${clip(stated ? check : `${verification.status}: ${check}`, 200)}`,
		qa ?? "QA: not run",
	].join("\n");
}
