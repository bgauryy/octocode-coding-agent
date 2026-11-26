import { bashDisplay } from "../../../files/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import type { FeatureSetup, FeatureContext } from "../../../../core/features/index.ts";
import { bashSessionEnv } from "../../../../core/tools/bash.ts";
import { createBashToolDefinition } from "../../../../core/tools/index.ts";
import { carrySavedOutput } from "../../../../core/tools/bash/stored-result.ts";
import { type Subcommands, say } from "../../../shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { runningWorkOf } from "../../../shared/running-work.ts";
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
import { type JobLinks, registerJobsCommand, reloadNotice } from "../../../files/bash-jobs/command.ts";
import { type ShellSettings, shellSettings, shellScript } from "../../../files/bash-jobs/shell.ts";
import { backgroundJoined, backgroundStarted } from "../../../files/bash/background.ts";
import { soleOngoingItem } from "../../../backlog/inferred-item.ts";
import { backgroundJoins } from "./background-joins.ts";
import { jobWorkRows } from "./work-rows.ts";
import { bashDescription, bashOutputSchema, bashParameters } from "../../../files/bash/declaration.ts";
import { capturePipeStatus } from "./pipe-status.ts";
import { ownerSpawnHook, runOwner, withRunOwner } from "./owner-env.ts";
import { agentNameOf } from "../../../shared/agent-name.ts";
import { refuseUnsandboxed } from "./unsandboxed.ts";
import { claudeCodeBashAliases } from "../../../shared/claude-code-aliases.ts";
import { activeCommandSandbox } from "../../../../utils/command-sandbox.ts";

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
	/** What `/jobs` adds after each command (the item a job serves, the lock it holds); the composition root passes it. */
	links: JobLinks = () => new Map(),
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
	const rows = backgroundJoins(
		api,
		jobs,
		() => current?.sessionManager?.getSessionId?.() ?? "standalone:bash",
		() => closing,
		(text) => current && say(current, text, "warning"),
	);
	const showJobs = () => work.set("bash", jobWorkRows(jobs));
	/** Jobs the model started with `wake: false`: a success of theirs is recorded as a digest and starts no turn. */
	const unawaited = new Set<string>();
	const report = (job: BashJob, exit: JobExit, wake: boolean) => {
		const digest = !wake && unawaited.delete(job.id) && !job.stopped && exit.code === 0;
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
			// The job log distinguishes IDs reused by another owner.
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
					content: jobReport(job, exit, digest),
					display: true,
					details: jobDetails(job, exit, wake),
				},
				{ triggerTurn: wake, deliverAs: wake ? "steer" : "followUp", together: true },
			);
			if (sending && typeof sending.then === "function") void Promise.resolve(sending).catch(deliveryFailed);
		} catch {
			deliveryFailed();
		}
	};
	const onExit = (job: BashJob, exit: JobExit) => {
		showJobs();
		rows.end(job, exit);
		// Reported at session_shutdown already, while the session could still record it.
		if (reportedAtShutdown.has(job)) return;
		if (job.verification) job.verification = finishVerification(job.verification, exit, job);
		// A user's stop, a stop at run end, and any job of a subagent start no turn: a child's own job must not wake it before or
		// after its final answer (a queued follow-up would run one more model turn per job), and a headless run's last job must
		// not replace the answer with a reply to its being stopped. A job that ends mid-run is read at the next step; one that
		// ends after the answer is recorded, and the parent's report gets its line.
		const succeeded = !job.stopped && exit.code === 0;
		report(
			job,
			exit,
			!closing &&
				job.stopped !== "user" &&
				job.stopped !== "run end" &&
				!envFlag(process.env, SUBAGENT_ENV) &&
				!(succeeded && unawaited.has(job.id)),
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
		// With its commands stopped, the sandbox's proxy and log monitor would keep a finished print run alive.
		await activeCommandSandbox()?.close?.();
		rows.stop();
		current = undefined;
	});
	api.renderers.message(JOB_TYPE, (message, { expanded, outputPad }, theme) =>
		renderJobMessage(contentText(message.content), expanded, theme, outputPad ?? 1, message.details),
	);

	if (commands) registerJobsCommand(commands, jobs, work, links);

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
			// Not strict: provider strict mode makes every optional field required and nullable, so each call would spell
			// out eight nulls and every request would carry a third more schema; a malformed call is refused with the schema anyway.
			// Programmatic callers receive `structuredContent` only from tools that declare its schema.
			...(builtin.outputSchema !== undefined ? { outputSchema: bashOutputSchema(builtin.outputSchema) } : {}),
			promptGuidelines: [...(builtin.promptGuidelines ?? []), renderPrompt("tools/bash/guidelines.md")],
			parameters: bashParameters,
			// `type` only selects the shell; a declared tool's name there is refused with the call to make instead.
			prepareArguments(args) {
				const misuse = shellTypeMisuse(args, () => api.tools.getAll().map((tool) => tool.name));
				if (misuse) throw new Error(misuse);
				// Before the permission gate could ask: `sandbox: "false"` or `0` is coerced to false only after this runs.
				if (isRecord(args)) refuseUnsandboxed(args.sandbox);
				return claudeCodeBashAliases(args) as never;
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				refuseUnsandboxed(params.sandbox);
				current = ctx;
				const settings = { ...settingsFor(ctx), type: params.type ?? "bash" };
				const sessionId = ctx.sessionManager?.getSessionId?.() ?? "standalone:bash";
				// Before the receipt begins: a command that changes files makes older checks stale, and its own check starts after its writes.
				await recordShellMutation(params.command, ctx.cwd, sessionId, settings.type === "powershell");
				const verification = params.verify ? beginVerification(params.command, ctx.cwd, sessionId) : undefined;
				const item = itemKey(params.item);
				// The field is declared for background jobs: a foreground call (which may still move to the background) ignores a non-ref.
				if (params.background && params.item !== undefined && !item)
					throw new Error(`item must be a backlog item ref like B12, not "${params.item}"`);
				// A background call without `item` serves the session's only ongoing item; the full-run lock names this owner.
				const inferred = params.background && !item ? soleOngoingItem(ctx) : undefined;
				const owner = runOwner(agentNameOf(api).get(), item ?? inferred);
				if (params.background) {
					const joined = rows.join({
						command: params.command,
						cwd: ctx.cwd,
						fresh: params.fresh,
						verify: params.verify,
					});
					if (joined) return backgroundJoined(joined, ctx.cwd, Date.now());
					const job = await jobs.start(params.command, ctx.cwd, params.timeout, onExit, {
						env: withRunOwner(bashSessionEnv(ctx), owner),
						shell: settings,
						verification,
						reason: params.reason,
						item: item ?? inferred,
						unsandboxed: params.sandbox === false,
					});
					if (verification) verification.startedAt = job.startedAt;
					if (params.wake === false) unawaited.add(job.id);
					try {
						rows.record(job, owner.agent);
					} catch (error) {
						// A job nothing can find or join is stopped rather than left running unseen.
						jobs.stop(job.id, "run end");
						throw error;
					}
					showJobs();
					return backgroundStarted(job, ctx.cwd, verification, inferred);
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
				// A sleep, which cannot move, was stopped because a message is waiting.
				let endedForMessage = false;
				const run = createBashToolDefinition(process.cwd(), {
					...settings,
					spawnHook: ownerSpawnHook(owner),
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
							stopOnMessage: movable ? undefined : () => (endedForMessage = true),
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
					const timer = (api.tools.getActive?.() ?? []).includes("notify");
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
						how:
							movedFor === "message" || endedForMessage ? "message" : capped ? "cap" : auto ? "threshold" : "deadline",
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
