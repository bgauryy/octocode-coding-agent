import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseSessionEntryLine } from "../../core/session-manager/entries.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { emptyUsage } from "../shared/util.ts";
import { type BudgetChild, budgetOutcome, hardLimit, maxRequests } from "./budget.ts";
import type { AgentProfile } from "./profiles.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import { childSessionFile } from "./process/session.ts";

/** Read the actual session arguments: an inherited child's transcript can live outside this parent's scratch folder. */
function option(args: string[], name: string): string | undefined {
	const index = args.lastIndexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

/** Count the append-only history, including abandoned branches and failed replies, without retaining its messages. */
async function savedRequests(args: string[], signal?: AbortSignal): Promise<number> {
	const dir = option(args, "--session-dir");
	const id = option(args, "--session-id");
	if (!dir || !id) return 0;
	const file = childSessionFile({ dir, id }, true);
	if (!file) return 0;
	const stream = createReadStream(file, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let requests = 0;
	try {
		for await (const line of lines) {
			const entry: unknown = parseSessionEntryLine(line);
			if (!entry && line.trim())
				throw new Error("Cannot account for subagent requests: repair the invalid transcript record before resuming.");
			if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant")
				requests += 1;
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return requests;
}

/**
 * Same child ID/transcript means the same count across messages, explicit resume, parked reopen and parent forks. A resume
 * is its parent's grant (`RequestBudget`), so only one no parent decided (`peerResumed`, a relayed peer's message) can
 * find the child with nothing left: that one runs nothing.
 */
export async function requestBudgetHistory(
	args: string[],
	profile: AgentProfile | undefined,
	child: BudgetChild & { peerResumed?: boolean; maxRequests?: number },
	signal?: AbortSignal,
): Promise<{ requests: number; limit: number; exhausted?: SubagentOutcome }> {
	// The task's own cap, checked against the profile's limit when it was planned (`taskRequestLimit`).
	const limit = child.maxRequests ?? maxRequests(profile);
	const requests = limit > 0 ? await savedRequests(args, signal) : 0;
	if (signal?.aborted) throw new Error("Subagent cancelled");
	const hard = hardLimit(limit);
	return {
		requests,
		limit,
		...(limit > 0 && child.peerResumed && requests >= hard
			? { exhausted: budgetOutcome(requests, { soft: limit, hard, allowance: hard }, child, "", emptyUsage()) }
			: {}),
	};
}
