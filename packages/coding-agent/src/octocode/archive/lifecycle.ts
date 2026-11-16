import { HistoryRepair } from "./repair.ts";
import { repairOnStart, writeOwnRows } from "./repair-stamps.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { agentEvents } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { activate, activationId } from "../shared/activation.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { notify } from "../shared/commands.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { projectAgents } from "./projection.ts";
import { saveCompaction, writeSummaryLibrary } from "./summaries.ts";

/** How long to wait before projecting again while another process rewrites the view, and how many times. */
const PROJECTION_RETRY_MS = 250;
const PROJECTION_RETRIES = 40;

/** Native lifecycle hooks; no configured user command is run by these records. */
export function registerArchiveLifecycle(
	api: ExtensionAPI,
	options: {
		canProject: () => boolean;
		agentId: () => string | undefined;
		parentId: () => string | undefined;
	},
): () => void {
	let unsubscribe: (() => void) | undefined;
	let lastProblem: string | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let queued: { timer: ReturnType<typeof setImmediate>; project: () => Promise<void> } | undefined;
	/** Moves at each session start and stop: a projection of an ended session schedules no retry. */
	let generation = 0;
	const stop = () => {
		generation += 1;
		unsubscribe?.();
		unsubscribe = undefined;
		// A projection the last commits asked for runs now: the session is ending or being replaced.
		const pending = queued;
		queued = undefined;
		if (pending) {
			clearImmediate(pending.timer);
			void pending.project();
		}
		if (retry) clearTimeout(retry);
		retry = undefined;
	};
	/**
	 * Whether `ctx` still belongs to the live session. A disposed session marks its ctx stale without a
	 * `session_shutdown`, so this instance would stay subscribed to the shared database's commits: it stops itself.
	 */
	const live = (ctx: ExtensionContext): boolean => {
		try {
			void ctx.hasUI;
			return true;
		} catch {
			stop();
			return false;
		}
	};
	const report = (ctx: ExtensionContext, error: unknown) => {
		if (!live(ctx)) return;
		const message = `Archive persistence: ${errorMessage(error)}`;
		if (message === lastProblem) return;
		lastProblem = message;
		if (ctx.hasUI) notify(ctx.ui, message, "warning");
		else process.stderr.write(`${message}\n`);
	};
	api.on("session_start", async (event, ctx) => {
		stop();
		const id = activate(ctx.sessionManager, event);
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			const agent = sharedAgentDb();
			const workspace = registeredWorkspace(ctx.cwd, agent);
			let busy = 0;
			let projectedSequence: number | undefined;
			// At most one projection writes at a time; a request meanwhile runs once after it, with the newest events.
			let running: Promise<void> | undefined;
			let again = false;
			const run = (): Promise<void> => {
				running = (async () => {
					try {
						const sequence = agentEvents.latestSequence(agent.db, workspace.id);
						if (sequence === projectedSequence) return;
						await projectAgents(agent, workspace.root, workspace);
						projectedSequence = sequence;
						lastProblem = undefined;
						busy = 0;
					} catch (error) {
						// The session ended or was replaced while this ran (its last projection runs at stop): its ctx is stale
						// and must not be touched. The view is derived from committed events, so the next session projects again.
						if (generation !== session) return;
						// Another process is writing the same generated view; the events are already committed. Project again
						// shortly (one pending retry, however many commits arrive) and warn only when the lock never frees.
						if (isRecord(error) && error.code === "ELOCKED" && busy < PROJECTION_RETRIES) {
							busy += 1;
							retry ??= setTimeout(() => {
								retry = undefined;
								void project();
							}, PROJECTION_RETRY_MS);
							retry.unref?.();
							return;
						}
						report(ctx, error);
					}
				})().finally(() => {
					running = undefined;
					if (!again) return;
					again = false;
					void run();
				});
				return running;
			};
			const project = (): Promise<void> => {
				// The view lists the whole workspace's events from the shared database: the parent's projection already shows a
				// child's, so a child would only compete for the file lock.
				if (envFlag(process.env, SUBAGENT_ENV) || !options.canProject() || !live(ctx)) return Promise.resolve();
				if (running) {
					again = true;
					return running;
				}
				return run();
			};
			const session = ++generation;
			// The view is derived: a commit only asks for it. However many commits land in one turn of the event loop, one
			// projection runs after it, off the committing caller's path, and skips when the newest event is already shown.
			unsubscribe = agent.onCommit(() => {
				queued ??= {
					timer: setImmediate(() => {
						queued = undefined;
						void project();
					}),
					project,
				};
			});
			agent.transaction(() =>
				agentEvents.append(agent.db, workspace.id, {
					id,
					time: new Date().toISOString(),
					name: null,
					parentId: options.parentId() ?? null,
					sessionId: ctx.sessionManager.getSessionId(),
					type: "init",
					version: 1,
					data: {
						agentId: null,
						activationId: id,
						reason: event.reason,
						parentSession: ctx.sessionManager.getHeader()?.parentSession ?? null,
					},
				}),
			);
			// Only what the transcript appended since the last complete repair of this file is read (a whole read otherwise).
			await repairOnStart(agent, new HistoryRepair(agent), file);
			await project();
		} catch (error) {
			report(ctx, error);
		}
	});
	api.on("session_compact", async (event, ctx) => {
		const transcript = ctx.sessionManager.getSessionFile();
		if (!transcript) return;
		try {
			const agent = sharedAgentDb();
			const sessionId = ctx.sessionManager.getSessionId();
			// The start offset of this transcript stays usable after this process's own row (`writeOwnRows`).
			writeOwnRows(agent, transcript, sessionId, () =>
				saveCompaction(agent, ctx.cwd, sessionId, event.compactionEntry, {
					transcript,
					activationId: activationId(ctx.sessionManager),
					agentId: options.agentId(),
				}),
			);
			await writeSummaryLibrary(agent, sessionId, process.env, ctx.cwd);
		} catch (error) {
			report(ctx, error);
		}
	});
	return stop;
}
