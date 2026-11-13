import type { Usage } from "@octocodeai/octocode-ai";
import type { ExtensionContext } from "../../core/features/index.ts";
import { runnerTask } from "../instructions/task.ts";
import { emptyUsage } from "../shared/util.ts";
import type { ChildProgress } from "./events.ts";
import type { Identity } from "./process/env.ts";
import { noAnswerError, type SubagentOutcome } from "./process/outcome.ts";
import { reportDir } from "./process/session.ts";
import { ReportTracker } from "./report.ts";
import type { RunnerBilling, RunnerReply, Runners } from "./runner-port.ts";

/** ACP stop reasons as a report reads them: a cut-off turn is incomplete, a refusal failed, a cancelled turn aborted. */
const STOP_REASONS: Record<string, string> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	refusal: "error",
	cancelled: "aborted",
};

/**
 * The runner's token totals as Octocode's `Usage`. A plan pays for its runner's turns, so the dollar figure it reports
 * (the API value) is no bill and counts nothing; other runs keep the dollar figure they reported.
 */
function usageOf(reply: RunnerReply): Usage {
	const usage = emptyUsage();
	const tokens = reply.usage;
	if (tokens) {
		usage.input = tokens.inputTokens;
		usage.output = tokens.outputTokens;
		usage.cacheRead = tokens.cachedReadTokens ?? 0;
		usage.cacheWrite = tokens.cachedWriteTokens ?? 0;
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	if (reply.billing !== "plan" && reply.cost !== undefined && reply.cost > 0) usage.cost.total = reply.cost;
	return usage;
}

/** One task run by an external runner, as `spawn.ts` starts it in place of an Octocode child process. */
export interface RunnerChildInput {
	runner: string;
	model?: string;
	task: string;
	cwd: string;
	identity: Identity;
	signal: AbortSignal | undefined;
	onProgress: (progress: ChildProgress) => void;
	onSpawn?: (pid: number) => void;
	ctx: ExtensionContext;
}

/**
 * Runs `task` in a connected runner and reads its answer as a child's report: the same contract, outcome word, scratch
 * copy and result schema check as a native child (`ReportTracker`). The row hears each tool call it streams. Returns
 * the outcome with who paid; a turn without an answer fails the way a native child's does.
 */
export async function runRunnerChild(
	runners: Runners,
	input: RunnerChildInput,
): Promise<SubagentOutcome & { billing?: RunnerBilling }> {
	if (input.signal?.aborted) throw new Error("Subagent cancelled");
	const { identity } = input;
	const report = new ReportTracker(identity.scratch ?? reportDir(identity.id), identity.resultContract);
	let usage = emptyUsage();
	// Progress is display only: a failure there must not end the run.
	const progress = (update: Omit<ChildProgress, "usage">) => {
		try {
			input.onProgress({ ...update, usage });
		} catch {
			// The final answer does not depend on the row.
		}
	};
	const model = input.model?.trim();
	const reply = await runners.turn({
		runner: input.runner,
		...(model ? { model } : {}),
		cwd: input.cwd,
		text: runnerTask(input.task, input.cwd),
		signal: input.signal ?? new AbortController().signal,
		onActivity: (line) => progress({ activity: line }),
		...(input.onSpawn ? { onStart: input.onSpawn } : {}),
		ctx: input.ctx,
	});
	usage = usageOf(reply);
	progress({ requests: 1 });
	const stop = STOP_REASONS[reply.stopReason ?? "end_turn"] ?? "stop";
	report.answer(reply.text, stop, stop === "error" ? `${input.runner} refused the task` : undefined);
	const result = report.result();
	if (!result.answered) throw new Error(result.error ?? noAnswerError(undefined));
	return {
		text: result.text,
		usage,
		billing: reply.billing,
		...(result.outcome ? { outcome: result.outcome, outcomeSource: result.outcomeSource } : {}),
		...(result.error ? { error: result.error } : {}),
		...(result.structured ? { structured: result.structured } : {}),
		...(result.reportArtifact ? { reportArtifact: result.reportArtifact } : {}),
	};
}
