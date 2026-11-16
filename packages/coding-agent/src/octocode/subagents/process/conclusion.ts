import type { RequestBudget } from "../budget.ts";
import { budgetOutcome } from "../budget.ts";
import type { ChildState } from "../events.ts";
import type { ReportTracker } from "../report.ts";
import { unavailableResult } from "../result-schema.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { redactSecrets, visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { Identity } from "./env.ts";
import { exitReason, LOAD_ERROR, noAnswerError, StartupError, type SubagentOutcome } from "./outcome.ts";
import type { StderrTail } from "./stderr.ts";

export interface Conclusion {
	report: ReturnType<ReportTracker["result"]>;
	code: number | null;
	exitSignal: NodeJS.Signals | null;
	streamFailure: Error | undefined;
	/** Why the watchdog stopped the child, once it has. */
	stalled: Error | undefined;
	/** The caller's signal aborted. */
	aborted: boolean;
	/** The child aborted itself and no run followed. */
	cancelled: boolean;
	budget: RequestBudget;
	identity: Identity;
	state: ChildState;
	stderr: StderrTail;
}

/** What a child's end comes to once its report is assembled: a failure to throw, or the outcome to return. */
export function concludeRun(end: Conclusion): { reject: Error } | { resolve: SubagentOutcome } {
	const { report, code, exitSignal, streamFailure, stalled, aborted, cancelled, budget, identity, state, stderr } = end;
	const { text: finalText, body: lastProgress, pointer, error, answered, outcome, outcomeSource } = report;
	if (streamFailure) return { reject: streamFailure };
	// A child stopped while settling after its answer still delivers that answer.
	if (stalled && !answered) return { reject: stalled };
	if (aborted && !answered) return { reject: new Error("Subagent cancelled") };
	if (budget.stopped !== undefined)
		return { resolve: budgetOutcome(budget.stopped, budget.limits, identity, lastProgress, state.usage) };
	// The child's report (already shown with visible escapes by `Report`) and stderr are untrusted text headed for the model and the terminal. A crash before any
	// final answer is a failure even when the child narrated progress first: narration is not a report.
	if (code !== 0 && !answered && !state.turnSeen) {
		// Exited before its first model turn: a short cause and where the whole stderr is, not its tail.
		const reason = stderr.firstError();
		const file = stderr.save();
		return {
			reject: new StartupError(
				`Subagent failed (startup): ${exitReason(code, exitSignal)} before its first model turn${reason ? `: ${reason}` : ""}${file ? `\nFull stderr: ${shortPath(file)}` : ""}`,
				LOAD_ERROR.test(stderr.text()) && state.toolsRunning === 0,
				reason,
				file,
			),
		};
	}
	if (code !== 0 && !answered) {
		// The progress text is already the report preview (bounded, with its own trim note); the pointer to the saved report is always kept.
		const last = finalText
			? `\nLast progress: ${lastProgress.trim()}${pointer ? `\n${visibleControls(pointer)}` : ""}`
			: "";
		// The tool call it made last, so the parent can tell which work died: stderr is often only startup warnings.
		const doing = state.lastActivity.startsWith("→")
			? `\nLast tool call: ${visibleControls(redactSecrets(state.lastActivity))}${state.toolsRunning > 0 ? " (still running)" : ""}`
			: "";
		return { reject: new Error(`Subagent ${exitReason(code, exitSignal)}: ${stderr.text()}${doing}${last}`) };
	}
	// A child that aborted itself (its compaction kept thrashing, say) says why in its last error notice. Error text from the
	// child can quote a credential (a provider's 401 body), so it is redacted before it reaches the parent.
	const lastError = state.notices.lastError === undefined ? undefined : redactSecrets(state.notices.lastError);
	const failure = cancelled
		? lastError
			? `Subagent stopped: ${lastError}`
			: "Subagent cancelled before its run settled"
		: ((error === undefined ? undefined : redactSecrets(error)) ?? (answered ? undefined : noAnswerError(lastError)));
	return {
		resolve: {
			text: finalText,
			...(report.reportArtifact ? { reportArtifact: report.reportArtifact } : {}),
			...(identity.resultContract
				? {
						structured:
							aborted || code !== 0 || failure
								? unavailableResult(identity.resultContract)
								: (report.structured ?? unavailableResult(identity.resultContract)),
					}
				: {}),
			usage: state.usage,
			...(outcome ? { outcome, outcomeSource } : {}),
			...(failure ? { error: failure } : {}),
		},
	};
}
