import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { adoptTree } from "../../../utils/process-tree.ts";
import { leadsProcessGroup, trackDetachedChildPid, untrackDetachedChildPid } from "../../../utils/shell.ts";
import { SHELL_GROUPS_FILE_ENV, stopShellGroups } from "../../shared/shell-groups.ts";
import { type ChildEffect, newChildState, parseEvent, reduceEvent } from "../events.ts";
import { RequestBudget } from "../budget.ts";
import { heartbeatDue, SETTLED_EXIT_MS } from "../liveness.ts";
import { ChildRelay } from "../relay.ts";
import { ReportTracker } from "../report.ts";
import { subagentProcessEnv } from "./env.ts";
import type { ChildResourceFiles } from "./handoff-files.ts";
import {
	EXIT_GRACE_MS,
	MAX_EVENT_BYTES,
	SUBAGENT_STOP_GRACE_MS,
	type SubagentOutcome,
	USER_STOP,
	USER_STOP_GRACE_MS,
	WATCHDOG,
} from "./outcome.ts";
import { concludeRun } from "./conclusion.ts";
import { leftBehind } from "./left-behind.ts";
import { startGate } from "../rate-gate.ts";
import { type ChildRun, RunPhase } from "./run-phase.ts";
import { reportDir } from "./session.ts";
import { savedNotices, StderrTail } from "./stderr.ts";
import { ChildWatchdog } from "./watchdog.ts";
import { ChildShutdown } from "./shutdown.ts";
import { hint } from "./caller-hint.ts";

/** How long a child whose run settled aborted, without this process asking, gets to start the run a team interrupt's message triggers. */
const INTERRUPT_FOLLOW_UP_MS = 1_500;

/** What `runChild` prepared before the spawn: the CLI, the request history, and the files the child reads. */
interface PreparedChild {
	command: string;
	prefix: string[];
	history: { limit: number; requests: number };
	/** The secret the team signs the user's messages with; empty when no file could carry it. */
	nonce: string;
	nonceFile: string | undefined;
	rolePromptFile: string | undefined;
	resources: ChildResourceFiles;
}

/** Spawns the child and supervises it to its report (`runChild` owns the files around it). */
export function superviseChild(run: ChildRun, prepared: PreparedChild): Promise<SubagentOutcome> {
	const { task, args, cwd, profile, identity, signal, onProgress, onSpawn, host } = run;
	if (signal?.aborted) return Promise.reject(new Error("Subagent cancelled"));
	const limits = run.limits ?? WATCHDOG;
	const ready = run.ready ?? (() => Promise.resolve());
	const { command, prefix, history, nonce, nonceFile } = prepared;
	const outputDir = identity.scratch ?? reportDir(identity.id);
	// The child's bash commands each lead a group outside its own: the child lists them here for `stopShellGroups`.
	const shellGroups = outputDir ? path.join(outputDir, "shell-groups.jsonl") : undefined;
	try {
		if (shellGroups) fs.rmSync(shellGroups, { force: true });
	} catch {
		// An old list only names groups that `stopShellGroups` proves are gone or not the child's.
	}
	return new Promise<SubagentOutcome>((resolve, reject) => {
		// Detached on POSIX so the child leads a process group: cancelling kills its whole tree (MCP servers, Chrome, bash).
		const child = spawn(command, [...prefix, ...args], {
			cwd,
			env: {
				...subagentProcessEnv(
					profile,
					process.env,
					identity,
					nonceFile,
					prepared.rolePromptFile,
					prepared.resources.skillSnapshotFile,
					prepared.resources.mcpServersFile,
				),
				...(shellGroups ? { [SHELL_GROUPS_FILE_ENV]: shellGroups } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: leadsProcessGroup(),
		});
		adoptTree(child.pid);
		// The group dies with this process on a crash or an emergency exit (`killTrackedDetachedChildren`), until it exits.
		const trackedPid = child.pid;
		if (trackedPid) trackDetachedChildPid(trackedPid, { graceful: true });
		const state = newChildState();
		const phase = new RunPhase();
		const report = new ReportTracker(outputDir, identity.resultContract);
		const stderr = new StderrTail(outputDir);
		let buffer = "";
		let frameBytes = 0;
		/** Why the run failed on this side: a stream that broke its contract, or an `onSpawn` that threw. */
		let streamFailure: Error | undefined;
		/** The child's last run settled aborted without anyone here asking (cleared when an interrupt's run starts). */
		let cancelled = false;
		/** When the child began waiting for the user's answer: it is not hung, however long the user takes. */
		let waitingSince = 0;
		/** The process exited or never started; a stop was asked for. Either ends the child's work (`working`). */
		let gone = false;
		let stopped = false;
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
		/** The run settled (its report is known), and then concluded (its outcome is out): `working` below. */
		let settledHere = false;
		let concludedHere = false;
		let resolveSettled: (() => void) | undefined;
		const settledEvent = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		/** The run settled for good: its report is known, though the child still exits and is cleaned up. */
		const onSettled = () => {
			settledHere = true;
			resolveSettled?.();
			hint(run.settled);
		};
		let onExit: (() => void) | undefined;
		const exitEvent = new Promise<void>((resolve) => {
			onExit = resolve;
		});
		const shutdown = new ChildShutdown({
			pid: child.pid,
			closeInput,
			abort: () => state.running && send({ type: "abort", holdShutdown: true }),
			settled: () => state.settledSeen,
			settledEvent,
			exitEvent,
		});
		const stopTreeNow = () => shutdown.stopTree(SUBAGENT_STOP_GRACE_MS);
		/**
		 * A settled child told to leave exits within `SETTLED_EXIT_MS`, or its process tree is stopped and its report
		 * delivered: its own busy deadline (25 minutes or more) is for a child that has not answered.
		 */
		const leave = () => {
			phase.cleanup(
				shutdown.closeInput().then(() => {
					phase.leave(report.hasReport ? SETTLED_EXIT_MS : undefined, () => phase.stop(stopTreeNow));
				}),
			);
		};
		// One stop per run. The run settles only after it: the SIGKILL of a tree that ignored SIGTERM (and of detached
		// helpers like a Chrome the child launched) then happens before the parent can exit, not on a timer lost with it.
		const abort = () => {
			stopped = true;
			hint(run.workingChanged);
			host?.budgets?.remove(identity.id, budget);
			relay.cancelAll();
			phase.stop(() => shutdown.stop(signal?.reason === USER_STOP ? USER_STOP_GRACE_MS : SUBAGENT_STOP_GRACE_MS));
		};
		// The request budget: one steer at the soft limit; at the hard limit one last request without tools, then the same
		// stop as above (0: off).
		const steer = (message: string) => void send({ type: "steer", message });
		const budget: RequestBudget = new RequestBudget(history.limit, steer, abort, history.requests, {
			final: (message) => {
				host?.budgets?.remove(identity.id, budget);
				void send({ type: "steer", message, toolChoice: "none" });
			},
			// A foreground child's parent is inside this call, and one without the team has no parent to write to.
			canAsk: Boolean(identity.parentId) && !identity.parentWaits,
			resumeIsGrant: identity.peerResumed !== true,
		});
		host?.budgets?.add(identity.id, budget, () => state.usage.cost.total);
		const relay = new ChildRelay(identity, host, {
			// Without a file the child holds no secret: nothing it sends can carry one.
			nonce: nonceFile ? nonce : "",
			send: (response) => {
				send({ type: "extension_ui_response", ...response });
				return undefined;
			},
			onWaiting: (waiting) => {
				const now = Date.now();
				if (waiting) {
					waitingSince = now;
					hint(run.workingChanged);
				} else {
					watchdog.waited(now - waitingSince, now);
					stamp(now);
				}
				host?.awaitingApproval?.(identity.id, waiting);
				progress({ usage: state.usage, waiting });
			},
		});
		// The row's "last progress": a model or tool event, the end of a wait for the user, or a heartbeat inside declared long work. A stdout byte is none.
		const stamp = (at: number) => host?.output?.(identity.id, at);
		const watchdog = new ChildWatchdog(
			state,
			limits,
			() => Boolean(streamFailure) || relay.open > 0,
			abort,
			(now, resumed) => {
				if (resumed ? state.running : heartbeatDue(state, now, relay.open > 0)) stamp(now);
			},
		);
		watchdog.start();
		// Whether the child still works toward its answer: its sibling reports may wait for it (`report-groups.ts`). Once it
		// settled, whether its report is still on its way: it leaves, exits and is cleaned up, until a stall or the outcome.
		const working = () =>
			settledHere
				? !concludedHere && !streamFailure && !watchdog.stalled
				: !gone && !stopped && !streamFailure && !watchdog.stalled && relay.open === 0;
		hint(run.working && (() => run.working?.(working)));
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
			if (!event) return;
			const before = state.progressAt;
			for (const effect of reduceEvent(state, event, limits, Date.now())) perform(effect);
			if (state.progressAt !== before) stamp(state.progressAt);
		};
		/** Nothing here asked for the stop: no abort, no broken stream, no spent budget. */
		const unrequested = () => !signal?.aborted && !streamFailure && budget.stopped === undefined;
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
					return leave();
				case "settled":
					// Octocode can abort after a normal reply or between tools without an aborted assistant message.
					// A watchdog stopping shutdown after an answer still preserves that completed report.
					cancelled = effect.aborted && !watchdog.stalled;
					phase.cancelFollowUp();
					// An abort nobody here asked for may be a team interrupt: the child's held message starts its next run right
					// after this settle, and closed input would end that run. It leaves only if no run starts within the grace.
					if (cancelled && unrequested()) {
						phase.followUp(INTERRUPT_FOLLOW_UP_MS, () => {
							if (state.running) cancelled = false;
							else {
								onSettled();
								leave();
							}
						});
						return;
					}
					// A report that names no outcome: the child is asked for the word once and leaves after that answer.
					if (!effect.aborted && unrequested())
						if (report.lacksOutcome && send({ type: "prompt", message: report.askOutcome() })) return;
					host?.budgets?.remove(identity.id, budget);
					onSettled();
					return leave();
				case "incoming":
					return report.incoming(effect.role, effect.job, effect.quiet, effect.reminder);
				case "answer":
					return report.answer(effect.text, effect.stopReason, effect.errorMessage, effect.waiting, effect.reminder);
				case "request":
					return budget.onReply(effect.count, effect.continues);
				case "responding":
					return progress({ usage: state.usage, responding: true });
			}
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (streamFailure) return;
			watchdog.activeAt = Date.now();
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
		const finish = (): boolean => {
			if (!phase.conclude()) return false;
			host?.budgets?.remove(identity.id, budget);
			relay.cancelAll();
			watchdog.stop();
			signal?.removeEventListener("abort", abort);
			return true;
		};
		child.on("error", (error) => {
			gone = true;
			hint(run.exited);
			hint(run.workingChanged);
			stderr.close();
			if (finish()) reject(error);
		});
		child.on("exit", (code, exitSignal) => {
			onExit?.();
			gone = true;
			hint(run.exited);
			hint(run.workingChanged);
			// A dialog of a child that is gone has nobody to answer: close it in the parent's UI.
			relay.cancelAll();
			if (phase.concluded) return;
			watchdog.stop();
			// What the child left in its own process group (an MCP server, a dev server, a Chrome) dies with the run, and
			// before the run settles: the caller removes the child's worktree next, and a holder must not outlive that.
			// Judged with one asynchronous `ps`: an exit never waits for it on the thread that draws the screen. The run
			// settles only after this cleanup, which may end after the run concluded: the stop then starts on its own.
			phase.cleanup(
				Promise.all([leftBehind(child.pid), shutdown.hasDescendants()]).then(([left, retained]) => {
					if (!left && !retained) return undefined;
					phase.stop(stopTreeNow);
					return phase.stopping ?? stopTreeNow();
				}),
			);
			// So do the bash commands it ran in groups of their own, which a child that crashed could not stop itself.
			phase.cleanup(stopShellGroups(shellGroups));
			phase.exited(EXIT_GRACE_MS, () => settle(code, exitSignal));
		});
		child.on("close", (code, exitSignal) => settle(code, exitSignal));
		const settle = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			const pending = phase.pending();
			if (!finish()) {
				// Settled earlier by a spawn `error`: once the exit cleanup ends, the exit hook must not signal a reused pid.
				if (trackedPid) void Promise.resolve(pending).then(() => untrackDetachedChildPid(trackedPid));
				return;
			}
			if (pending) void pending.then(() => conclude(code, exitSignal));
			else conclude(code, exitSignal);
		};
		const conclude = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
			// A child stopped after it settled and delivered its report did not fail by leaving late.
			const code = phase.leftLate && report.hasReport ? 0 : exitCode;
			// Until here the exit hook also reaches what the child left in its group.
			if (trackedPid) untrackDetachedChildPid(trackedPid);
			for (const stream of [child.stdout, child.stderr]) stream.destroy();
			if (buffer.trim()) handleLine(buffer);
			relay.end();
			stderr.close();
			const saved = savedNotices(state, outputDir);
			if (saved) progress({ usage: state.usage, notices: saved });
			const result = report.result();
			startGate.noteFailure(result.error);
			const end = concludeRun({
				report: result,
				code,
				exitSignal,
				streamFailure,
				stalled: watchdog.stalled,
				aborted: signal?.aborted === true,
				cancelled,
				budget,
				identity,
				state,
				stderr,
			});
			concludedHere = true;
			if ("reject" in end) reject(end.reject);
			else resolve(end.resolve);
		};
		// Attach only after abort's dependencies exist, then catch cancellation during setup or before attachment.
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		// Install cleanup before invoking a callback that can fail (for example, recording worktree ownership).
		try {
			if (child.pid !== undefined) onSpawn?.(child.pid);
		} catch (error) {
			streamFailure = error instanceof Error ? error : new Error(String(error));
			abort();
		}
		// A wait ended by an abort sends nothing: `abort` stops the child. A child waiting there is not stalled (`hold`).
		if (!streamFailure)
			void watchdog.hold(ready()).then(
				() => {
					if (gone || stopped || phase.concluded) return;
					if (streamFailure || signal?.aborted) return;
					stamp(Date.now());
					if (send({ type: "prompt", message: budget.prompt(task) })) phase.prompted();
				},
				() => undefined,
			);
	});
}
