import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { getCliInvocation } from "../../../config.ts";
import { writeRolePrompt } from "../../instructions/role.ts";
import { formatDuration, shortPath } from "../../shared/format.ts";
import { sessionOutputDir } from "../../shared/home.ts";
import { adoptTree, prepareTree, stopTree } from "../../shared/process.ts";
import { visibleControls } from "../../shared/sanitize.ts";
import { settleWithin } from "../../shared/util.ts";
import {
	type ChildEffect,
	type ChildProgress,
	newChildState,
	parseEvent,
	reduceEvent,
	type WatchdogLimits,
} from "../events.ts";
import { budgetOutcome, maxRequests, RequestBudget } from "../budget.ts";
import type { AgentProfile } from "../profiles.ts";
import { ChildRelay, type RelayHost } from "../relay.ts";
import { ReportTracker } from "../report.ts";
import { unavailableResult } from "../result-schema.ts";
import { type Identity, subagentProcessEnv, writeNonceFile } from "./env.ts";
import { prepareChildResourceFiles, removeChildResourceFiles, type ChildResourceFiles } from "./handoff-files.ts";
import {
	ABORT_SETTLE_MS,
	EXIT_GRACE_MS,
	exitReason,
	LOAD_ERROR,
	MAX_EVENT_BYTES,
	NO_ANSWER,
	StartupError,
	SUBAGENT_STOP_GRACE_MS,
	type SubagentOutcome,
	USER_STOP,
	USER_STOP_GRACE_MS,
	WATCHDOG,
} from "./outcome.ts";
import { leftBehind } from "./left-behind.ts";
import { startGate } from "../rate-gate.ts";
import { reportDir } from "./session.ts";
import { savedNotices, StderrTail } from "./stderr.ts";

/** How long a child whose run settled aborted, without this process asking, gets to start the run a team interrupt's message triggers. */
const INTERRUPT_FOLLOW_UP_MS = 1_500;

/**
 * Runs one child in Octocode's RPC mode and resolves with its report. The task is sent as a `prompt` command on stdin. The
 * child's dialogs (`extension_ui_request`) go to `host.ui` when the parent can ask a person (see `ChildRelay`) and are
 * answered `cancelled` otherwise, which is what a child with no UI got before; its audit entries go to `host.permission`.
 * stdin is closed once the run settles (RPC children do not exit by themselves), and a stop is `abort`, then
 * `agent_settled`, then closed stdin, with signals only for a child that does not follow.
 */
export async function runChild(
	task: string,
	args: string[],
	cwd: string,
	profile: AgentProfile | undefined,
	identity: Identity,
	signal: AbortSignal | undefined,
	onProgress: (progress: ChildProgress) => void,
	onSpawn?: (pid: number) => void,
	limits: WatchdogLimits = WATCHDOG,
	host?: RelayHost,
): Promise<SubagentOutcome> {
	if (signal?.aborted) throw new Error("Subagent cancelled");
	const { command, prefix } = getCliInvocation();
	// Windows: the helper that owns the child's job runs before the child, so no grandchild escapes the job.
	await prepareTree();
	if (signal?.aborted) throw new Error("Subagent cancelled");
	// The team signs the user's messages to this child with the nonce for as long as the child runs.
	// The secret reaches the child through an owner-only file, never its environment or arguments (`PERMISSION_NONCE_FILE_ENV`).
	let resources: ChildResourceFiles = {};
	let nonceFile: string | undefined;
	let vouched: (() => void) | undefined;
	try {
		resources = prepareChildResourceFiles(identity);
		const rolePromptFile = profile?.prompt ? writeRolePrompt(profile.prompt, sessionOutputDir("output")) : undefined;
		const nonce = randomBytes(16).toString("hex");
		nonceFile = writeNonceFile(nonce, identity.id);
		vouched = nonceFile ? host?.vouch?.(identity.id, nonce) : undefined;
		if (!nonceFile)
			host?.permission.relayNote(
				identity.id,
				"no secret file could be written for this subagent: its audit entries and permission headers are not accepted, and the user's messages to it are not signed",
			);
		return await new Promise<SubagentOutcome>((resolve, reject) => {
			// Detached on POSIX so the child leads a process group: cancelling kills its whole tree (MCP servers, Chrome, bash).
			const child = spawn(command, [...prefix, ...args], {
				cwd,
				env: subagentProcessEnv(
					profile,
					process.env,
					identity,
					nonceFile,
					rolePromptFile,
					resources.skillSnapshotFile,
					resources.mcpServersFile,
				),
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			adoptTree(child.pid);
			const state = newChildState();
			const outputDir = identity.scratch ?? reportDir(identity.id);
			const report = new ReportTracker(outputDir, identity.resultContract);
			const stderr = new StderrTail(outputDir);
			let buffer = "";
			let frameBytes = 0;
			let streamFailure: Error | undefined;
			// A write to a child that already exited fails with EPIPE; its exit settles the run.
			child.stdin.on("error", () => undefined);
			const send = (command: Record<string, unknown>): boolean => {
				if (child.stdin.destroyed || child.stdin.writableEnded) return false;
				child.stdin.write(`${JSON.stringify(command)}\n`);
				return true;
			};
			/** Closing stdin is how an RPC child is told to shut down in order. */
			const closeInput = () => {
				if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
			};
			let onSettled: (() => void) | undefined;
			const settledEvent = new Promise<void>((resolve) => {
				onSettled = resolve;
				return undefined;
			});
			let onExit: (() => void) | undefined;
			const exitEvent = new Promise<void>((resolve) => {
				onExit = resolve;
				return undefined;
			});
			const stop = async (graceMs: number): Promise<void> => {
				if (state.running && send({ type: "abort" })) await settleWithin(settledEvent, ABORT_SETTLE_MS);
				closeInput();
				// A child that settled leaves on its own once its input is closed; one that did not gets the signals at once.
				if (state.settledSeen) await settleWithin(exitEvent, graceMs);
				await stopTree(child.pid, graceMs);
			};
			// One stop per run. The run settles only after it: the SIGKILL of a tree that ignored SIGTERM (and of detached
			// helpers like a Chrome the child launched) then happens before the parent can exit, not on a timer lost with it.
			let stopped: Promise<void> | undefined;
			const abort = () => {
				relay.cancelAll();
				stopped ??= stop(signal?.reason === USER_STOP ? USER_STOP_GRACE_MS : SUBAGENT_STOP_GRACE_MS).catch(
					() => undefined,
				);
			};
			signal?.addEventListener("abort", abort, { once: true });
			// The request budget: one steer at the soft limit, the same stop as above at the hard limit (0: off).
			const budget = new RequestBudget(maxRequests(profile), (message) => void send({ type: "steer", message }), abort);
			// Watchdog: a child stuck on a stalled model stream emits nothing; stop it instead of spinning forever.
			let activeAt = Date.now();
			let stalled: Error | undefined;
			let cancelled = false;
			/** Waits after an unrequested aborted settle for the run an interrupt's message starts. */
			let followUp: NodeJS.Timeout | undefined;
			// While the child waits for the user's answer it is not hung, however long the user takes.
			let waitingSince = 0;
			const relay = new ChildRelay(identity, host, {
				// Without a file the child holds no secret: nothing it sends can carry one.
				nonce: nonceFile ? nonce : "",
				send: (response) => {
					send({ type: "extension_ui_response", ...response });
					return undefined;
				},
				onWaiting: (waiting) => {
					const now = Date.now();
					if (waiting) waitingSince = now;
					else {
						// The wait does not count against the child's deadlines.
						state.busyUntil += now - waitingSince;
						activeAt = now;
					}
					progress({ usage: state.usage, waiting });
				},
			});
			const watchdog = setInterval(
				() => {
					const now = Date.now();
					if (streamFailure || stalled || relay.open > 0) return;
					const busy = state.toolsRunning > 0 || state.settling;
					if (busy ? now < state.busyUntil : now - activeAt < limits.idleMs) return;
					stalled = busy
						? new Error(
								`Subagent stopped: ${state.lastActivity} ran past its own deadline; last output ${formatDuration(now - activeAt)} ago. Its process tree was killed.`,
							)
						: new Error(
								`Subagent stopped: no output for ${formatDuration(now - activeAt)}; last activity: ${state.lastActivity}, ${formatDuration(now - activeAt)} ago. Its process tree was killed.`,
							);
					abort();
				},
				Math.max(250, Math.min(30_000, limits.idleMs / 4)),
			);
			watchdog.unref();
			// Progress is display only: a failure there (a screenshot write, a stale render) must not throw out of the stream handler.
			const progress: typeof onProgress = (update) => {
				try {
					onProgress(update);
				} catch {
					// Keep the run going; the final answer does not depend on it.
				}
			};
			const handleLine = (line: string) => {
				const event = parseEvent(line);
				if (event) for (const effect of reduceEvent(state, event, limits, Date.now())) perform(effect);
			};
			const perform = (effect: ChildEffect) => {
				switch (effect.kind) {
					case "progress":
						return progress(effect.update);
					case "ui":
						return relay.handle(effect.event);
					case "rejected":
						streamFailure = new Error(effect.message);
						return abort();
					case "close":
						return closeInput();
					case "settled":
						// Octocode can abort after a normal reply or between tools without an aborted assistant message.
						// A watchdog stopping shutdown after an answer still preserves that completed report.
						cancelled = effect.aborted && !stalled;
						clearTimeout(followUp);
						// An abort nobody here asked for may be a team interrupt: the child's held message starts its next run right
						// after this settle, and closed input would end that run. It leaves only if no run starts within the grace.
						if (cancelled && !signal?.aborted && !streamFailure && budget.stopped === undefined) {
							followUp = setTimeout(() => {
								if (state.running) cancelled = false;
								else {
									onSettled?.();
									closeInput();
								}
							}, INTERRUPT_FOLLOW_UP_MS);
							return;
						}
						onSettled?.();
						return closeInput();
					case "incoming":
						return report.incoming(effect.role, effect.job);
					case "answer":
						return report.answer(effect.text, effect.stopReason, effect.errorMessage);
					case "request":
						return budget.onReply(effect.count, effect.continues);
					case "responding":
						return progress({ usage: state.usage, responding: true });
				}
			};
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				if (streamFailure) return;
				activeAt = Date.now();
				let start = 0;
				while (start < chunk.length) {
					const newline = chunk.indexOf("\n", start);
					const part = chunk.slice(start, newline < 0 ? undefined : newline);
					frameBytes += Buffer.byteLength(part);
					if (frameBytes > MAX_EVENT_BYTES) {
						streamFailure = new Error(`Subagent JSON event exceeds ${MAX_EVENT_BYTES} bytes`);
						buffer = "";
						abort();
						return;
					}
					buffer += part;
					if (newline < 0) break;
					handleLine(buffer);
					buffer = "";
					frameBytes = 0;
					start = newline + 1;
				}
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.write(chunk));
			// The run settles once, from `close` (stdio drained) or, when a grandchild that left the process group keeps the
			// pipes open, from `exit` plus a short grace: the tool call must return and its slot be freed either way.
			let finished = false;
			let exitGrace: NodeJS.Timeout | undefined;
			const finish = (): boolean => {
				if (finished) return false;
				finished = true;
				relay.cancelAll();
				clearInterval(watchdog);
				clearTimeout(exitGrace);
				clearTimeout(followUp);
				signal?.removeEventListener("abort", abort);
				return true;
			};
			child.on("error", (error) => {
				stderr.close();
				if (finish()) reject(error);
			});
			child.on("exit", (code, exitSignal) => {
				onExit?.();
				// A dialog of a child that is gone has nobody to answer: close it in the parent's UI.
				relay.cancelAll();
				if (finished) return;
				clearInterval(watchdog);
				// What the child left in its own process group (an MCP server, a dev server, a Chrome) dies with the run, and
				// before the run settles: the caller removes the child's worktree next, and a holder must not outlive that.
				if (leftBehind(child.pid)) stopped ??= stopTree(child.pid, SUBAGENT_STOP_GRACE_MS).catch(() => undefined);
				exitGrace = setTimeout(() => settle(code, exitSignal), EXIT_GRACE_MS);
			});
			child.on("close", (code, exitSignal) => settle(code, exitSignal));
			const settle = (code: number | null, exitSignal: NodeJS.Signals | null) => {
				if (!finish()) return;
				if (stopped) void stopped.then(() => conclude(code, exitSignal));
				else conclude(code, exitSignal);
			};
			const conclude = (code: number | null, exitSignal: NodeJS.Signals | null) => {
				for (const stream of [child.stdout, child.stderr]) stream.destroy();
				if (buffer.trim()) handleLine(buffer);
				relay.end();
				stderr.close();
				const saved = savedNotices(state, outputDir);
				if (saved) progress({ usage: state.usage, notices: saved });
				const {
					text: finalText,
					body: lastProgress,
					pointer,
					error,
					answered,
					outcome,
					outcomeSource,
					structured,
				} = report.result();
				startGate.noteFailure(error);
				if (streamFailure) reject(streamFailure);
				// A child stopped while settling after its answer still delivers that answer.
				else if (stalled && !answered) reject(stalled);
				else if (signal?.aborted && !answered) reject(new Error("Subagent cancelled"));
				else if (budget.stopped !== undefined)
					resolve(budgetOutcome(budget.stopped, budget.limit, lastProgress, state.usage, identity.resultContract));
				// The child's report (already shown with visible escapes by `Report`) and stderr are untrusted text headed for the model and the terminal. A crash before any
				// final answer is a failure even when the child narrated progress first: narration is not a report.
				else if (code !== 0 && !answered && !state.turnSeen) {
					// Exited before its first model turn: a short cause and where the whole stderr is, not its tail.
					const reason = stderr.firstError();
					const file = stderr.save();
					reject(
						new StartupError(
							`Subagent failed (startup): ${exitReason(code, exitSignal)} before its first model turn${reason ? `: ${reason}` : ""}${file ? `\nFull stderr: ${shortPath(file)}` : ""}`,
							LOAD_ERROR.test(stderr.text()) && state.toolsRunning === 0,
							reason,
							file,
						),
					);
				} else if (code !== 0 && !answered) {
					// The progress text is already the report preview (bounded, with its own trim note); the pointer to the saved report is always kept.
					const last = finalText
						? `\nLast progress: ${lastProgress.trim()}${pointer ? `\n${visibleControls(pointer)}` : ""}`
						: "";
					reject(new Error(`Subagent ${exitReason(code, exitSignal)}: ${stderr.text()}${last}`));
				} else {
					// A child that aborted itself (its compaction kept thrashing, say) says why in its last error notice.
					const failure = cancelled
						? state.notices.lastError
							? `Subagent stopped: ${state.notices.lastError}`
							: "Subagent cancelled before its run settled"
						: (error ?? (answered ? undefined : NO_ANSWER));
					resolve({
						text: finalText,
						...(identity.resultContract
							? {
									structured:
										signal?.aborted || code !== 0 || failure
											? unavailableResult(identity.resultContract)
											: (structured ?? unavailableResult(identity.resultContract)),
								}
							: {}),
						usage: state.usage,
						...(outcome ? { outcome, outcomeSource } : {}),
						...(failure ? { error: failure } : {}),
					});
				}
			};
			// Install cleanup before invoking a callback that can fail (for example, recording worktree ownership).
			try {
				if (child.pid !== undefined) onSpawn?.(child.pid);
			} catch (error) {
				streamFailure = error instanceof Error ? error : new Error(String(error));
				abort();
			}
			if (!streamFailure) send({ type: "prompt", message: task });
		});
	} finally {
		try {
			vouched?.();
		} catch {
			process.stderr.write("Unable to release a subagent permission handoff\n");
		}
		for (const file of [nonceFile]) {
			if (!file) continue;
			try {
				fs.rmSync(file, { force: true });
			} catch {
				process.stderr.write("Unable to remove a private subagent handoff file\n");
			}
		}
		removeChildResourceFiles(resources);
	}
}
