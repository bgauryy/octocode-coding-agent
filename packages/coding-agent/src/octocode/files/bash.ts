import { bashDisplay } from "./display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { bashSessionEnv } from "../../core/tools/bash.ts";
import { createBashToolDefinition } from "../../core/tools/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { runningWorkOf, type WorkRow } from "../shared/running-work.ts";
import { contentText, wholeSeconds } from "../shared/util.ts";
import { BashJobs } from "./bash-jobs.ts";
import { createReadHint } from "./read-hint.ts";
import { BASH_ABORT_GRACE_MS, foregroundOperations, type HandoffReason, strayNote } from "./bash-run.ts";
import { foregroundPlan, timeLeft } from "./bash/auto.ts";
import { sleepHint } from "./bash/long-commands.ts";
import { hostQuirkHint } from "./bash/host-hints.ts";
import type { BashDetails } from "./outcome.ts";
import { renderBashResult, renderJobMessage } from "./render.ts";
import { adoptFullOutput, CLAMP_NOTE, foregroundFailure, orphanNotice } from "./bash/results.ts";
import {
	beginVerification,
	finishVerification,
	foregroundReceipt,
	pendingVerification,
	verificationJson,
	verificationLine,
} from "./bash/verification.ts";
import { bashConcurrency, recordShellMutation } from "./bash/mutation.ts";
import { timedTool } from "../render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { BashJob, JobExit } from "./bash-jobs/types.ts";
import { JOB_TYPE } from "../shared/messages.ts";
import { jobDetails, jobReport } from "./bash-jobs/report.ts";
import { reapOrphanJobs } from "./bash-jobs/records.ts";
import { registerJobsCommand, reloadNotice } from "./bash-jobs/command.ts";
import { type ShellSettings, shellSettings, shellScript } from "./bash-jobs/shell.ts";
import { backgroundStarted } from "./bash/background.ts";
import { bashDescription, bashOutputSchema, bashParameters, renderBashCall } from "./bash/declaration.ts";

/**
 * Octocode's `bash`, with two changes: a waited-for command has a deadline when the call names none (Octocode's has none, so a
 * server, watcher or prompt hangs the turn until the user presses Esc), and `background: true` starts a job whose exit
 * arrives later as a message. The foreground path is Octocode's own tool (streaming, truncation, the live `Elapsed` timer,
 * the user's `shellPath` and `shellCommandPrefix` settings), with the timeout filled in and its process handling from
 * bash-run.ts (a grace before SIGKILL, processes left running are named). Background jobs use the same shell, prefix
 * and environment. Job logs and the full output of a truncated command live in the session's `bash/` folder
 * (`sessionOutputDir`), never in the shared temp directory.
 */

export function registerBashTool(
	api: ExtensionAPI,
	commands?: Subcommands,
	jobs = new BashJobs(),
	settingsFor: (ctx: ExtensionContext) => ShellSettings = (ctx) => shellSettings(ctx.cwd, ctx.isProjectTrusted()),
): BashJobs {
	// Octocode's bash, for its output schema; each call builds its own with that call's settings and process handling.
	const builtin = createBashToolDefinition(process.cwd());
	const readHint = createReadHint(
		() => api.getActiveTools?.() ?? [],
		envFlag(process.env, SUBAGENT_ENV) ? Number.POSITIVE_INFINITY : undefined,
	);
	let current: ExtensionContext | undefined;
	// Set from session_shutdown: a job that ends meanwhile reports without waking anyone.
	let closing = false;
	let sessionGeneration = 0;
	const reportedAtShutdown = new WeakSet<BashJob>();
	const work = runningWorkOf(api);
	/** Publishes the running jobs to the footer's typed counts and the work rows above it (`team/panel.ts`). */
	const showJobs = () =>
		work.set(
			"bash",
			[...jobs.jobs.values()].map((job): WorkRow => {
				const command = job.command.trim().split("\n", 1)[0] ?? "";
				const reason = job.reason?.trim();
				return {
					kind: "bash",
					id: job.id,
					title: reason || command,
					...(reason && command ? { detail: command } : {}),
					startedAt: job.startedAt,
				};
			}),
		);
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
				{ triggerTurn: wake, deliverAs: "followUp", together: true },
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
		// A user's stop, a stop at run end, and any job of a subagent start no turn: a child's own job must not wake it before or
		// after its final answer (a queued follow-up would run one more model turn per job), and a headless run's last job must
		// not replace the answer with a reply to its being stopped. A job that ends mid-run is read at the next step; one that
		// ends after the answer is recorded, and the parent's report gets its line.
		report(
			job,
			exit,
			!closing && job.stopped !== "user" && job.stopped !== "run end" && !envFlag(process.env, SUBAGENT_ENV),
		);
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
			abortGraceMs: BASH_ABORT_GRACE_MS,
			// A command that changes something runs alone in its message; reads stay concurrent.
			concurrency: bashConcurrency,
			description: bashDescription(),
			// What the shell is for, then the work other tools own: code research goes to the declared search and read tools,
			// content changes to `file` (checkpointed for /rewind). `sed` stays out of the list so it does not read as an editor.
			promptSnippet: renderInstruction("tools/bash/snippet.md"),
			...(builtin.constrainedSampling !== undefined ? { constrainedSampling: builtin.constrainedSampling } : {}),
			// Programmatic callers receive `structuredContent` only from tools that declare its schema.
			...(builtin.outputSchema !== undefined ? { outputSchema: bashOutputSchema(builtin.outputSchema) } : {}),
			// A pipe such as `cmd | tail` exits with the last command's status, so a failing build would read as passing.
			promptGuidelines: [...(builtin.promptGuidelines ?? []), renderInstruction("tools/bash/guidelines.md")],
			parameters: bashParameters,
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
					showJobs();
					return backgroundStarted(job, ctx.cwd, verification);
				}
				const plan = foregroundPlan(params, settings.backgroundAfterSeconds);
				const { timeout, clamped, movable, auto, deliberate, capped } = plan;
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
									// A call with its own timeout still stops its command then, wherever it runs by that time.
									const left = timeLeft(plan.stopAfterSeconds, startedAt);
									const moved = { output, startedAt, verification, reason: params.reason, timeout: left };
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
					// For the model only, so it stays out of `notices`, which the terminal shows.
					const hint =
						settings.type === "bash" && !raw.details?.exitCode
							? readHint(params.command, ctx.cwd, sessionId)
							: undefined;
					const timer = (api.getActiveTools?.() ?? []).includes("timer");
					const waitHint = settings.type === "bash" ? sleepHint(params.command, timer) : undefined;
					const notes = [...notices, ...(hint ? [hint] : []), ...(waitHint ? [waitHint] : [])].join("\n\n");
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
						how: movedFor === "message" ? "message" : capped ? "cap" : auto ? "threshold" : "deadline",
					});
				}
			},
			renderCall: renderBashCall,
			renderResult: renderBashResult,
			display: bashDisplay,
		}),
	);
	return jobs;
}
