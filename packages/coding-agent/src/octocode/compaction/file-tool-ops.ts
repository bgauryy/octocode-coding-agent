import path from "node:path";
import type { SessionBeforeCompactEvent } from "../../core/features/index.ts";
import { appliedFileOutcomes } from "../files/reads.ts";
import { resolveToolPath } from "../shared/home.ts";
import { recordedLocalReads } from "../shared/local-reads.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { parts } from "./images.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];

/**
 * Adds every path the `file` tool changed in the summarized messages to Octocode's modified-file list (in place). A call's
 * result is found by `toolCallId`; a path counts only when its outcome is `ok`, read from the outcome itself
 * (`appliedFileOutcomes`), so a `patch` call counts as a `queries` call does, and a batch in which one query failed
 * (an error result) still counts the others (a call where every query failed has no details). Adds every file Octocode's local tools read (their verified `details.localReads`,
 * as `seenFiles` reads them; native sessions have no `read` tool) to the read-file list. Those paths are absolute, so one
 * that a call changed under a relative path leaves that list here: `computeFileLists` compares the spellings.
 */
export function addFileToolOps(
	preparation: Pick<Preparation, "fileOps" | "messagesToSummarize" | "turnPrefixMessages">,
	cwd: string,
): void {
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const results = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolCallId === "string") results.set(message.toolCallId, message);
		if (!message.isError)
			for (const read of recordedLocalReads(message.details)) preparation.fileOps.read.add(read.file);
	}
	for (const message of messages) {
		for (const part of parts(message)) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "file") continue;
			const result = typeof part.id === "string" ? results.get(part.id) : undefined;
			if (!result) continue;
			for (const outcome of appliedFileOutcomes(result.details)) preparation.fileOps.edited.add(outcome.path);
		}
	}
	const { read, edited, written } = preparation.fileOps;
	const changed = new Set([...edited, ...written].map((file) => resolveToolPath(cwd, file)));
	for (const file of read) if (path.isAbsolute(file) && changed.has(file)) read.delete(file);
}
