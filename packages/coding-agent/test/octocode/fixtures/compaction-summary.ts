import { userMessagesSection } from "../../../src/octocode/compaction/checkpoint-text.ts";
import { transcriptNote } from "../../../src/octocode/compaction/summary.ts";

/** A summary as Octocode writes it: the model's checkpoint, the kept user messages and the Recovery section for the next model. */
export function writtenSummary(): string {
	const messages = userMessagesSection([], 0, ["fix the login bug\nit fails on Safari"], undefined, 3, null);
	const recovery = transcriptNote("/sessions/s.jsonl", false, [
		"Folder /sessions/s/archive (library.md indexes every segment). This compaction is segment 3. Search it with the archive tool.",
	]);
	return `## Goal\nFix the login bug\n\n## TL;DR\nDid the work.${messages}${recovery}`;
}
