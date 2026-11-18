import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { AwaitsAnswer } from "./compaction/warm-wait.ts";
import { contentText } from "./shared/util.ts";
import { reportStatus } from "./subagents/report-outcome.ts";

/**
 * Whether this agent waits for an answer it asked for: a `replyRequired` question it sent is still unanswered
 * (`unansweredAsks`), or, as a subagent, its last answer reported `blocked` and waits for its coordinator's decision.
 */
export function awaitsAnswer(isSubagent: boolean, unansweredAsks: () => number): AwaitsAnswer {
	return (ctx) => {
		if (isSubagent && reportStatus(lastAnswer(ctx.sessionManager.getBranch?.() ?? [])) === "blocked") return true;
		return unansweredAsks() > 0;
	};
}

/** The text of the branch's last assistant reply, if any. */
function lastAnswer(branch: readonly unknown[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role === "assistant") return contentText(entry.message.content);
	}
	return undefined;
}
