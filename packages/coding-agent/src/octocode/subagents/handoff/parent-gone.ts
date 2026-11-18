import { renderPrompt } from "../../../core/prompt-template.ts";
import path from "node:path";
import { AGENT_ID_ENV, AGENT_RUN_ID_ENV, PARENT_PID_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { sessionDir } from "../../shared/home.ts";
import { sessionWorkspace } from "../../shared/home/workspace.ts";
import { savePendingReport } from "./pending.ts";

/**
 * The id of the stop report saved for child `id`'s run `run` (its `RunDetails.runId`, which the child reads from
 * `OCTOCODE_AGENT_RUN_ID`). Both sides use it: the child when its parent is gone, the parent when it saves the report of a
 * run that outlived its session (`run-execution.ts`). Fixed, so whichever copies are saved, one is delivered
 * (`takePendingReports` and `ReportQueue` drop a repeated `reportId`).
 */
export const parentGoneReportId = (id: string, run: string): string => sha256(`parent-gone\0${id}\0${run}`);

/**
 * A child whose parent process is gone is the only process left that knows how it ended: before it exits it saves a
 * `stopped` report in the parent session's `reports/pending` (the parent's workspace, `OCTOCODE_TEAM_WORKSPACE`), where the
 * resumed parent takes it as a late report. It does not wake the parent: continuing the child is offered, never automatic.
 * Returns the saved file; undefined when this process is no subagent or the report could not be saved.
 */
export function saveParentGoneReport(
	env: NodeJS.ProcessEnv,
	last: { summary?: string; transcript?: string } = {},
): string | undefined {
	const parentSession = env[PARENT_SESSION_ENV]?.trim();
	const id = env[AGENT_ID_ENV]?.trim();
	if (!parentSession || !id) return undefined;
	const dir = path.join(sessionDir(parentSession, env, sessionWorkspace(process.cwd(), env)), "reports", "pending");
	const summary = last.summary ?? `Stopped (${id} · parent process ended)`;
	return savePendingReport(dir, id, {
		content: renderPrompt("notices/subagents/parent-gone.md", {
			id,
			summary,
			transcript: last.transcript ? ` Its transcript: ${homeTilde(last.transcript)}.` : "",
		}),
		wake: false,
		details: { id, status: "stopped", summary },
		// Without a run id (a parent that did not set one) its pid and this process name the run.
		reportId: parentGoneReportId(id, env[AGENT_RUN_ID_ENV]?.trim() || `${env[PARENT_PID_ENV] ?? ""} ${process.pid}`),
	});
}
