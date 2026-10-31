import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseSessionEntryLine } from "../../core/session-manager/entries.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { emptyUsage } from "../shared/util.ts";
import { budgetOutcome, hardLimit, maxRequests } from "./budget.ts";
import type { AgentProfile } from "./profiles.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import { childSessionFile } from "./process/session.ts";
import type { ResultContract } from "./result-schema.ts";

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

/** Same child ID/transcript means the same budget across messages, explicit resume, parked reopen and parent forks. */
export async function requestBudgetHistory(
	args: string[],
	profile: AgentProfile | undefined,
	contract: ResultContract | undefined,
	signal?: AbortSignal,
): Promise<{ requests: number; limit: number; exhausted?: SubagentOutcome }> {
	const limit = maxRequests(profile);
	const requests = limit > 0 ? await savedRequests(args, signal) : 0;
	if (signal?.aborted) throw new Error("Subagent cancelled");
	return {
		requests,
		limit,
		...(limit > 0 && requests >= hardLimit(limit)
			? { exhausted: budgetOutcome(requests, limit, "", emptyUsage(), contract) }
			: {}),
	};
}
