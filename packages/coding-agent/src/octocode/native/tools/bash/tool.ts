import { bashDisplay } from "../../../files/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import type { FeatureSetup, FeatureContext } from "../../../../core/features/index.ts";
import { bashSessionEnv } from "../../../../core/tools/bash.ts";
import { createBashToolDefinition } from "../../../../core/tools/index.ts";
import { carrySavedOutput } from "../../../../core/tools/bash/stored-result.ts";
import { type Subcommands, say } from "../../../shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { runningWorkOf, type WorkRow } from "../../../shared/running-work.ts";
import { contentText, wholeSeconds } from "../../../shared/util.ts";
import { BashJobs } from "../../../files/bash-jobs.ts";
import { reapForegroundGroups } from "../../../files/bash-groups.ts";
import { createReadHint } from "../../../files/read-hint.ts";
import { BASH_ABORT_GRACE_MS, foregroundOperations, type HandoffReason, strayNote } from "../../../files/bash-run.ts";
import { foregroundPlan, timeLeft } from "../../../files/bash/auto.ts";
import { sleepHint } from "../../../files/bash/long-commands.ts";
import { hostQuirkHint } from "../../../files/bash/host-hints.ts";
import { shellTypeMisuse } from "../../../files/bash/shell-type.ts";
import type { BashDetails } from "../../../files/outcome.ts";
import { renderBashCall, renderBashResult, renderJobMessage } from "../../../files/render.ts";
import { adoptFullOutput, CLAMP_NOTE, foregroundFailure, orphanNotice } from "../../../files/bash/results.ts";
import {
	beginVerification,
	finishVerification,
	foregroundReceipt,
	pendingVerification,
	verificationJson,
	verificationText,
} from "../../../files/bash/verification.ts";
import { bashConcurrency, recordShellMutation } from "../../../files/bash/mutation.ts";
import { timedTool } from "../../../render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { BashJob, JobExit } from "../../../files/bash-jobs/types.ts";
import { JOB_TYPE } from "../../../shared/messages.ts";
import { itemKey, wakeGateOf } from "../../../wake/gate.ts";
import { jobDetails, jobReport } from "../../../files/bash-jobs/report.ts";
import { reapOrphanJobs } from "../../../files/bash-jobs/records.ts";
import { registerJobsCommand, reloadNotice } from "../../../files/bash-jobs/command.ts";
import { type ShellSettings, shellSettings, shellScript } from "../../../files/bash-jobs/shell.ts";
import { backgroundStarted } from "../../../files/bash/background.ts";
import { bashDescription, bashOutputSchema, bashParameters } from "../../../files/bash/declaration.ts";
import { capturePipeStatus } from "./pipe-status.ts";
import { activeCommandSandbox } from "../../../../utils/command-sandbox.ts";

/** The refusal of `sandbox: false` when the `sandbox.allowUnsandboxed` setting is false. */
const UNSANDBOXED_REFUSED =
	"sandbox: false is refused: the sandbox.allowUnsandboxed setting is false, so every agent command runs sandboxed. Change the command to fit the sandbox, or ask the user to change that setting.";

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
	api: FeatureSetup,
	commands?: Subcommands,
	jobs = new BashJobs(),
	settingsFor: (ctx: FeatureContext) => ShellSettings = (ctx) => shellSettings(ctx.cwd, ctx.isProjectTrusted()),
): BashJobs {
	// Octocode's bash, for its output schema; each call builds its own with that call's settings and process handling.
	const builtin = createBashToolDefinition(process.cwd());
	const readHint = createReadHint(() => api.tools.getActive?.() ?? []);
	let current: FeatureContext | undefined;
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
					...(job.item ? { item: job.item } : {}),
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
			const sending = wakeGateOf(api).emit(
				{
					kind: "job.exit",
					job: job.id,
					exit: exit.code,
					durationMs: exit.seconds * 1000,
					startedAt: job.startedAt,
					log: job.log,
					...(job.stopped ? { stopped: true } : {}),
				},
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

	api.bus.on("session_start", async (event, ctx) => {
		sessionGeneration++;
		current = ctx;
		closing = false;
		// Octocode has no hook before a reload: the jobs it stopped are named here, from the note the shutdown left.
		const reloaded = event?.reason === "reload" ? jobs.takeReloadNote() : [];
		if (reloaded.length > 0) say(ctx, reloadNotice(reloaded), "warning");
		// Subagents leave this to the top-level Octocode.
		if (envFlag(process.env, SUBAGENT_ENV)) return;
		const [orphans, groups] = await Promise.all([reapOrphanJobs(jobs.recordDirs()), reapForegroundGroups()]);
		if (orphans.length > 0) say(ctx, orphanNotice(orphans), "warning");
		const stopped = groups.filter((group) => group.stopped).map((group) => group.label);
		if (stopped.length > 0)
			say(ctx, `Stopped commands an ended Octocode left running: ${stopped.join("; ")}`, "warning");
	});
	api.bus.on("session_shutdown", async (event) => {
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
	api.renderers.message(JOB_TYPE, (message, { expanded, outputPad }, theme) =>
		renderJobMessage(contentText(message.content), expanded, theme, outputPad ?? 1),
	);

	if (commands) registerJobsCommand(commands, jobs);

	api.tools.register(
		timedTool({
			name: "bash",
			label: "bash",
			abortGraceMs: BASH_ABORT_GRACE_MS,
			effect: { kind: "exec" },
			// A command that changes something runs alone in its message; reads stay concurrent.
			concurrency: bashConcurrency,
			description: bashDescription(),
			// What the shell is for, then the work other tools own: code research goes to the declared search and read tools,
			// content changes to `file` (checkpointed for /rewind). `sed` stays out of the list so it does not read as an editor.
			promptSnippet: renderPrompt("tools/bash/snippet.md"),
			...(builtin.constrainedSampling !== undefined ? { constrainedSampling: builtin.constrainedSampling } : {}),
			// Programmatic callers receive `structuredContent` only from tools that declare its schema.
			...(builtin.outputSchema !== undefined ? { outputSchema: bashOutputSchema(builtin.outputSchema) } : {}),
			promptGuidelines: [...(builtin.promptGuidelines ?? []), renderPrompt("tools/bash/guidelines.md")],
			parameters: bashParameters,
			// `type` only selects the shell; a declared tool's name there is refused with the call to make instead.
			prepareArguments(args) {
				const misuse = shellTypeMisuse(args, () => api.tools.getAll().map((tool) => tool.name));
				if (misuse) throw new Error(misuse);
				if (isRecord(args) && args.sandbox === false && activeCommandSandbox()?.allowsUnsandboxed === false)
					throw new Error(UNSANDBOXED_REFUSED);
				return args as never;
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				current = ctx;
				const settings = { ...settingsFor(ctx), type: params.type ?? "bash" };
				const sessionId = ctx.sessionManager?.getSessionId?.() ?? "standalone:bash";
				// Before the receipt begins: a command that changes files makes older checks stale, and its own check starts after its writes.
				await recordShellMutation(params.command, ctx.cwd, sessionId, settings.type === "powershell");
				const verification = params.verify ? beginVerification(params.command, ctx.cwd, sessionId) : undefined;
				const item = itemKey(params.item);
				if (params.item !== undefined && !item)
					throw new Error(`item must be a backlog item ref like B12, not "${params.item}"`);
				if (params.background) {
					const job = await jobs.start(params.command, ctx.cwd, params.timeout, onExit, {
						env: bashSessionEnv(ctx),
						shell: settings,
						verification,
						reason: params.reason,
						item,
						unsandboxed: params.sandbox === false,
					});
					if (verification) verification.startedAt = job.startedAt;
					showJobs();
					return backgroundStarted(job, ctx.cwd, verification);
				}
				const plan = foregroundPlan(params, settings.backgroundAfterSeconds, process.env, settings.longCommands);
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
									const moved = { output, startedAt, verification, reason: params.reason, item, timeout: left };
									adopted = jobs.adopt(child, params.command, ctx.cwd, onExit, moved);
									if (verification) verification.startedAt = startedAt;
									showJobs();
									return adopted;
								}
							: undefined,
						(signalCode) => {
							endedBy = signalCode;
						},
						{
							watch: { pending: () => ctx.hasPendingMessages() },
							stopAtDeadline: deliberate,
							unsandboxed: params.sandbox === false,
						},
					),
				});
				const pipes = settings.type === "bash" ? capturePipeStatus(jobs.logDir()) : undefined;
				try {
					const raw = await run.execute(
						toolCallId,
						{
							command: shellScript(pipes?.script(params.command) ?? params.command, settings),
							timeout,
							maxOutputTokens: params.maxOutputTokens,
						},
						signal,
						(update) => {
							spilled = update.details?.fullOutputPath ?? spilled;
							onUpdate?.(update);
						},
						ctx,
					);
					const stray = group === undefined ? undefined : await strayNote(group);
					const quirk = raw.details?.exitCode ? hostQuirkHint(contentText(raw.content), params.command) : undefined;
					const notices = [stray, pipes?.finish(), clamped ? `(${CLAMP_NOTE})` : undefined, quirk].filter(
						(note) => note !== undefined,
					);
					// For the model only, so it stays out of `notices`, which the terminal shows.
					const hint =
						settings.type === "bash" && !raw.details?.exitCode
							? readHint(params.command, ctx.cwd, sessionId)
							: undefined;
					const timer = (api.tools.getActive?.() ?? []).includes("wait");
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
						const structuredContent = { ...asRecord(output), verification: verificationJson(receipt) };
						carrySavedOutput(output, structuredContent);
						return {
							...value,
							content: [
								{
									type: "text" as const,
									text: [contentText(value.content), verificationText(receipt)].filter(Boolean).join("\n\n"),
								},
							],
							structuredContent,
							details: {
								...finalDetails,
								verification: receipt,
								notices: [...(finalDetails.notices ?? []), verificationText(receipt)].filter(Boolean),
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
					// The saved output moved: storing the result refers to it where it is now, without reading it.
					carrySavedOutput(output, structured.structuredContent ?? asRecord(output), moved.path);
					return completed(
						{
							...result,
							...structured,
							content: [{ type: "text" as const, text: moved.text }],
						},
						{ ...details, fullOutputPath: moved.path },
					);
				} catch (error) {
					pipes?.finish();
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
