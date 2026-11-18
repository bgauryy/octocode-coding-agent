import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { CompletionInfo } from "../../shared/completion-info.ts";
import { BACKLOG_CHANGE_CHANNEL, type BacklogChange, type BacklogChangeNotice } from "../../shared/backlog-change.ts";
import type { HookEvent } from "../catalog.ts";
import { hookObserver } from "./observe.ts";
import type { Dispatch, HookSession, HooksView, ReportFailure } from "./types.ts";

/** Hook input is plain text: secrets in what an agent wrote into a completion or a note are masked before a script sees it. */
const masked = (value: unknown): unknown =>
	value === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(value)));

/** The input of a TaskCreated or BacklogChange hook (the dispatcher adds `hook_event_name`, `session_id` and `cwd`). */
function changeHookInput(change: BacklogChange, own: boolean): Record<string, unknown> {
	return {
		audit_id: change.id,
		task_id: change.ref,
		change: change.kind,
		by: change.by,
		surface: change.surface ?? null,
		own,
		state: change.state ?? null,
		assignee: change.assignee ?? null,
		before_assignee: change.beforeAssignee ?? null,
		parent_id: change.parent ?? null,
		paths: change.paths,
		task_subject: change.title ?? null,
		version: change.version ?? null,
		target: change.target ?? null,
		note: masked(change.text) ?? null,
	};
}

/** The input of a TaskCompleted hook. */
function completionHookInput(info: CompletionInfo): Record<string, unknown> {
	return {
		task_id: info.ref,
		task_subject: info.title,
		task_description: info.goal,
		teammate_name: info.assignee ?? null,
		change: info.change,
		completion: masked(info.completion) ?? null,
		close: masked(info.close) ?? null,
	};
}

/**
 * The backlog events: TaskCreated (an item this process added) and BacklogChange (every audited change, any process or
 * surface, matcher = change kind) observe in the background under the presence deadline and wait for session end;
 * TaskCompleted is asked by the `backlog` tool before it writes `done` or `close`, and a block refuses the write. Returns that ask.
 */
export function registerBacklogHooks(
	api: FeatureSetup,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): HooksView["taskCompleted"] {
	let context: FeatureContext | undefined;
	const { observe: run, settled } = hookObserver(session, { dispatch, reportFailure }, { defer: false });
	const observe = (event: HookEvent, name: string, input: Record<string, unknown>, ctx: FeatureContext) =>
		run(event, name, () => input, ctx);
	api.bus.on("session_start", async (_event, ctx) => {
		context = ctx;
	});
	api.channels.on(BACKLOG_CHANGE_CHANNEL, (value) => {
		if (!context) return;
		const { change, own } = value as BacklogChangeNotice;
		if (change.kind === "created" && own) observe("TaskCreated", "created", changeHookInput(change, own), context);
		observe("BacklogChange", change.kind, changeHookInput(change, own), context);
	});
	api.bus.on("session_shutdown", async () => {
		await settled();
		context = undefined;
	});
	return async (info, ctx, signal) => {
		if (session.config.TaskCompleted.length === 0) return undefined;
		const verdict = await dispatch(ctx, "TaskCompleted", [info.change], () => completionHookInput(info), signal, [
			"octocode",
		]);
		return verdict.block;
	};
}
