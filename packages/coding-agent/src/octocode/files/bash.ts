import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { bashSessionEnv, maxOutputTokensParameter } from "../../core/tools/bash.ts";
import { createBashToolDefinition } from "../../core/tools/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { formatDuration } from "../shared/format.ts";
import { toolHeader } from "../shared/render.ts";
import { STATUS } from "../shared/status.ts";
import { contentText, wholeSeconds } from "../shared/util.ts";
import { BashJobs } from "./bash-jobs.ts";
import { foregroundOperations, type HandoffReason, strayNote } from "./bash-run.ts";
import { foregroundPlan } from "./bash/auto.ts";
import { hostQuirkHint } from "./bash/host-hints.ts";
import { type BashDetails, renderBashResult, renderJobMessage } from "./render.ts";
import {
	adoptFullOutput,
	CLAMP_NOTE,
	DEFAULT_BASH_TIMEOUT,
	jobLines,
	MAX_FOREGROUND_TIMEOUT,
	foregroundFailure,
	orphanNotice,
} from "./bash/results.ts";
import {
	beginVerification,
	finishVerification,
	foregroundReceipt,
	pendingVerification,
	verificationJson,
	verificationLine,
	verificationSchema,
} from "./bash/verification.ts";
import { recordShellMutation } from "./bash/mutation.ts";
import { reasonSchema } from "../shared/reason.ts";
import { timedTool } from "../shared/render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { BashJob, JobExit } from "./bash-jobs/types.ts";
import { JOB_TYPE } from "../shared/messages.ts";
import { jobDetails, jobReport } from "./bash-jobs/report.ts";
import { reapOrphanJobs } from "./bash-jobs/records.ts";
import { registerJobsCommand, reloadNotice } from "./bash-jobs/command.ts";
import { type ShellSettings, shellSettings, shellScript } from "./bash-jobs/shell.ts";

/**
 * Octocode's `bash`, with two changes: a waited-for command has a deadline when the call names none (Octocode's has none, so a
 * server, watcher or prompt hangs the turn until the user presses Esc), and `background: true` starts a job whose exit
 * arrives later as a message. The foreground path is Octocode's own tool (streaming, truncation, the live `Elapsed` timer,
 * the user's `shellPath` and `shellCommandPrefix` settings), with the timeout filled in and its process handling from
 * bash-run.ts (a grace before SIGKILL, processes left running are named). Background jobs use the same shell, prefix
 * and environment. Job logs and the full output of a truncated command live in the session's `bash/` folder
 * (`sessionOutputDir`), never in the shared temp directory.
 */

/** `structuredContent` of a background start; a foreground command returns Octocode's own bash output. */
const BACKGROUND_OUTPUT = Type.Object({
	job: Type.String({ description: "Job id, for `/jobs kill <id>`" }),
	pid: Type.Number({ description: "Process group leader" }),
	log: Type.String({ description: "Log file with the combined output" }),
	verification: Type.Optional(verificationSchema),
});

export function registerBashTool(
	api: ExtensionAPI,
	commands?: Subcommands,
	jobs = new BashJobs(),
	settingsFor: (ctx: ExtensionContext) => ShellSettings = (ctx) => shellSettings(ctx.cwd, ctx.isProjectTrusted()),
): BashJobs {
	// Octocode's bash, for its output schema; each call builds its own with that call's settings and process handling.
	const builtin = createBashToolDefinition(process.cwd());
	let current: ExtensionContext | undefined;
	// Set from session_shutdown: a job that ends meanwhile reports without waking anyone.
	let closing = false;
	let sessionGeneration = 0;
	const reportedAtShutdown = new WeakSet<BashJob>();
	const showJobs = () => {
		try {
			if (current)
				current.ui.setStatus(
					STATUS.bash,
					jobs.jobs.size > 0 ? `${jobs.jobs.size} bash job${jobs.jobs.size === 1 ? "" : "s"}` : undefined,
					"accent",
				);
		} catch {
			// The session was replaced.
		}
	};
	const report = (job: BashJob, exit: JobExit, wake: boolean) => {
		const context = current;
		const generation = sessionGeneration;
		const deliveryFailed = () => {
			if (!context || closing || current !== context || sessionGeneration !== generation) return;
			try {
				say(context, `Bash job ${job.id} report failed. Output log: ${job.log}`, "warning");
			} catch {
				// The session UI ended.
			}
		};
		try {
			// Follow-up records output after this turn; the log distinguishes job IDs reused by a later instance.
			const sending = api.sendMessage(
				{
					customType: JOB_TYPE,
					content: jobReport(job, exit),
					display: true,
					details: jobDetails(job, wake),
				},
				{ triggerTurn: wake, deliverAs: "followUp" },
			);
			if (sending && typeof sending.then === "function") void Promise.resolve(sending).catch(deliveryFailed);
		} catch {
			deliveryFailed();
		}
	};
	const onExit = (job: BashJob, exit: JobExit) => {
		showJobs();
		// Reported at session_shutdown already, while the session could still record it.
		if (reportedAtShutdown.has(job)) return;
		if (job.verification) job.verification = finishVerification(job.verification, exit, job);
		// A user's stop, and any job of a subagent, start no turn: a child's own job must not wake it before or after its final
		// answer (a queued follow-up would run one more model turn per job). A job that ends mid-run is read at the next step; one
		// that ends after the answer is recorded, and the parent's report gets its line.
		report(job, exit, !closing && job.stopped !== "user" && !envFlag(process.env, SUBAGENT_ENV));
	};

	api.on("session_start", async (event, ctx) => {
		sessionGeneration++;
		current = ctx;
		closing = false;
		// Octocode has no hook before a reload: the jobs it stopped are named here, from the note the shutdown left.
		const reloaded = event?.reason === "reload" ? jobs.takeReloadNote() : [];
		if (reloaded.length > 0) say(ctx, reloadNotice(reloaded), "warning");
		// Subagents leave this to the top-level Octocode.
		if (envFlag(process.env, SUBAGENT_ENV)) return;
		const orphans = await reapOrphanJobs(jobs.recordDirs());
		if (orphans.length > 0) say(ctx, orphanNotice(orphans), "warning");
	});
	api.on("session_shutdown", async (event) => {
		closing = true;
		const reason = event?.reason === "reload" ? "reload" : "session end";
		const now = Date.now();
		const running = jobs.running();
		// Reported before stopping, without waking anyone: a resumed session then knows they did not finish.
		for (const job of running) {
			job.stopped ??= reason;
			reportedAtShutdown.add(job);
			const exit = { code: null, signal: null, seconds: wholeSeconds(now - job.startedAt) };
			if (job.verification) job.verification = pendingVerification(job.verification, job);
			report(job, exit, false);
		}
		if (reason === "reload") jobs.noteReload(running);
		// A job that exited just before reports its own status once its last output drained (within the drain time).
		const ending = [...jobs.jobs.values()].filter((job) => job.exited).map((job) => job.done);
		await Promise.all([jobs.stopAll(reason), ...ending]);
		current = undefined;
	});
	api.registerMessageRenderer(JOB_TYPE, (message, { expanded, outputPad }, theme) =>
		renderJobMessage(contentText(message.content), expanded, theme, outputPad ?? 1),
	);

	if (commands) registerJobsCommand(commands, jobs);

	api.registerTool(
		timedTool({
			name: "bash",
			label: "bash",
			description:
				"Run a command in the working directory. Foreground calls return combined output. " +
				`Background calls return a job id, pid and log path; completion arrives as a message. Use background: true for builds, full test suites, servers and anything over a minute; a foreground call moves to the background after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s or on a user message. Never sleep-poll for jobs or files. A timeout does not undo side effects: inspect the result before rerunning a command.`,
			// User request (2026-11-03): name the platform CLIs worth reaching for, and keep code research on the research tools.
			promptSnippet:
				"Run builds, tests, git, formatters and the platform's CLIs: move, copy and unpack files (mv, cp, tar, unzip), inspect binaries (file, strings), transform streams (sed, awk, jq); search and read code with the declared search and read tools, locally and on GitHub or package registries; cut long output with flags and pipes (tail, head, grep -c, sort); change file contents with `file`",
			...(builtin.constrainedSampling !== undefined ? { constrainedSampling: builtin.constrainedSampling } : {}),
			// Programmatic callers receive `structuredContent` only from tools that declare its schema.
			...(builtin.outputSchema !== undefined
				? {
						outputSchema: Type.Union([
							Type.Intersect([builtin.outputSchema, Type.Object({ verification: Type.Optional(verificationSchema) })]),
							BACKGROUND_OUTPUT,
						]),
					}
				: {}),
			// A pipe such as `cmd | tail` exits with the last command's status, so a failing build would read as passing.
			promptGuidelines: [
				...(builtin.promptGuidelines ?? []),
				"Trimmed output is saved in full: read that file by line range instead of rerunning, or pass a smaller maxOutputTokens. Put `set -o pipefail;` before an explicit pipe so a failing command is not hidden by the last command's status.",
			],
			parameters: Type.Object({
				type: Type.Optional(
					StringEnum(["bash", "powershell"] as const, {
						description: "bash (default, configured shell) or powershell (Windows)",
					}),
				),
				command: Type.String({ description: "Command in the selected syntax" }),
				timeout: Type.Optional(
					Type.Number({
						description: `Seconds before the command is stopped: foreground default ${DEFAULT_BASH_TIMEOUT}s, at most ${MAX_FOREGROUND_TIMEOUT}s. Separately, a foreground call still running after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s moves to the background unless background is false. A background job has none unless given`,
					}),
				),
				maxOutputTokens: maxOutputTokensParameter,
				background: Type.Optional(
					Type.Boolean({
						description:
							"true: return at once with a job id; false with a timeout: wait in the foreground and stop at the timeout",
					}),
				),
				verify: Type.Optional(
					Type.Boolean({
						description:
							"Record a verification receipt tied to the current edits; a later edit makes it stale, and a zero exit proves only that the command succeeded.",
					}),
				),
				// Declared here (last, as the native wrapper adds it) so a job keeps it as its why.
				reason: reasonSchema(),
			}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				current = ctx;
				const settings = { ...settingsFor(ctx), type: params.type ?? "bash" };
				const sessionId = ctx.sessionManager?.getSessionId?.() ?? "standalone:bash";
				// Before the receipt begins: a command that changes files makes older checks stale, and its own check starts after its writes.
				await recordShellMutation(params.command, ctx.cwd, sessionId, settings.type === "powershell");
				const verification = params.verify ? beginVerification(params.command, ctx.cwd, sessionId) : undefined;
				if (params.background) {
					const job = await jobs.start(params.command, ctx.cwd, params.timeout, onExit, {
						env: bashSessionEnv(ctx),
						shell: settings,
						verification,
						reason: params.reason,
					});
					if (verification) verification.startedAt = job.startedAt;
					const timeout = job.timeout;
					showJobs();
					const text = [
						`Started ${job.id} in the background (pid ${job.pid}${timeout ? `, stopped after ${formatDuration(timeout * 1000)}` : ""}). Keep working: its exit status and output tail arrive as a message.`,
						...jobLines(job, ctx.cwd),
						...(verification ? [verificationLine(verification)] : []),
					].join("\n");
					return {
						content: [{ type: "text" as const, text }],
						structuredContent: {
							job: job.id,
							pid: job.pid,
							log: job.log,
							...(verification ? { verification: verificationJson(verification) } : {}),
						},
						details: {
							job: job.id,
							pid: job.pid,
							log: job.log,
							...(verification ? { verification, notices: [verificationLine(verification)] } : {}),
						},
					};
				}
				const { timeout, clamped, movable, auto, deliberate } = foregroundPlan(params, settings.backgroundAfterSeconds);
				// Octocode reports the spill file in its updates' details; a timeout or abort throws, and only the updates name it then.
				let spilled: string | undefined;
				let group: number | undefined;
				let endedBy: NodeJS.Signals | null = null;
				// A command still running at its deadline becomes a background job (see `adoptAtDeadline`).
				let adopted: BashJob | undefined;
				let movedFor = "deadline" as HandoffReason;
				const run = createBashToolDefinition(process.cwd(), {
					...settings,
					commandPrefix: undefined,
					maxOutputBytes: settings.outputMaxBytes,
					operations: foregroundOperations(
						settings,
						(pid) => {
							group = pid;
							return group;
						},
						movable
							? (child, output, startedAt, reason) => {
									movedFor = reason;
									const moved = { output, startedAt, verification, reason: params.reason };
									adopted = jobs.adopt(child, params.command, ctx.cwd, onExit, moved);
									if (verification) verification.startedAt = startedAt;
									showJobs();
									return adopted;
								}
							: undefined,
						(signalCode) => {
							endedBy = signalCode;
						},
						{ watch: { pending: () => ctx.hasPendingMessages() }, stopAtDeadline: deliberate },
					),
				});
				try {
					const raw = await run.execute(
						toolCallId,
						{ command: shellScript(params.command, settings), timeout, maxOutputTokens: params.maxOutputTokens },
						signal,
						(update) => {
							spilled = update.details?.fullOutputPath ?? spilled;
							onUpdate?.(update);
						},
						ctx,
					);
					const stray = group === undefined ? undefined : strayNote(group);
					const quirk = raw.details?.exitCode ? hostQuirkHint(contentText(raw.content), params.command) : undefined;
					const notices = [stray, clamped ? `(${CLAMP_NOTE})` : undefined, quirk].filter((note) => note !== undefined);
					const notes = notices.join("\n\n");
					const result = notes
						? { ...raw, content: [{ type: "text" as const, text: `${contentText(raw.content)}\n\n${notes}` }] }
						: raw;
					const details: BashDetails = { ...result.details, ...(notices.length ? { notices } : {}) };
					const completed = (value: typeof result, finalDetails: BashDetails) => {
						if (!verification) return { ...value, details: finalDetails };
						const output = value.structuredContent;
						const receipt = foregroundReceipt(verification, endedBy, output, finalDetails);
						return {
							...value,
							content: [
								{ type: "text" as const, text: `${contentText(value.content)}\n\n${verificationLine(receipt)}` },
							],
							structuredContent: { ...asRecord(output), verification: verificationJson(receipt) },
							details: {
								...finalDetails,
								verification: receipt,
								notices: [...(finalDetails.notices ?? []), verificationLine(receipt)],
							},
						};
					};
					if (!details.fullOutputPath) return completed(result, details);
					const moved = adoptFullOutput(contentText(result.content), details.fullOutputPath, jobs.logDir());
					if (!moved.path) return completed(result, details);
					const output = result.structuredContent;
					const structured =
						isRecord(output) && output.full_output_path
							? { structuredContent: { ...output, full_output_path: moved.path } }
							: {};
					return completed(
						{
							...result,
							...structured,
							content: [{ type: "text" as const, text: moved.text }],
						},
						{ ...details, fullOutputPath: moved.path },
					);
				} catch (error) {
					return foregroundFailure(error, {
						spilled,
						dir: jobs.logDir(),
						adopted,
						seconds: timeout,
						clamped,
						cwd: ctx.cwd,
						verification,
						how: movedFor === "message" ? "message" : auto ? "threshold" : "deadline",
					});
				}
			},
			renderCall(args, theme, context) {
				// The timeout shows only when the model set one; the default deadline is in the tool description.
				const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
				const timeout = asked ? `timeout ${formatDuration(asked * 1000)}` : "";
				const meta = [args.background ? "background" : "", timeout].filter(Boolean).join(" · ");
				return toolHeader(
					theme,
					context,
					args.type === "powershell" ? "PowerShell" : "Bash",
					typeof args.command === "string" ? args.command : "",
					meta ? { meta } : {},
				);
			},
			renderResult: renderBashResult,
		}),
	);
	return jobs;
}
