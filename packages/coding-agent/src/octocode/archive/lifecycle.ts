import { HistoryRepair } from "./repair.ts";
import { repairOnStart, writeOwnRows } from "./repair-stamps.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { agentEvents } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { activate, activationId } from "../shared/activation.ts";
import { workspaceDb } from "../../storage/workspace-database.ts";
import { notify } from "../shared/commands.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { ForeignViewError, projectAgents, viewSignature } from "./projection.ts";
import { saveCompaction, writeSummaryLibrary } from "./summaries.ts";

/** How long to wait before projecting again while another process rewrites the view, and how many times. */
const PROJECTION_RETRY_MS = 250;
const PROJECTION_RETRIES = 40;

/** Native lifecycle hooks; no configured user command is run by these records. */
export function registerArchiveLifecycle(
	api: FeatureSetup,
	options: {
		canProject: () => boolean;
		agentId: () => string | undefined;
		parentId: () => string | undefined;
	},
): () => void {
	let unsubscribe: (() => void) | undefined;
	/** Each distinct problem warns once per session. */
	const reported = new Set<string>();
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
	const live = (ctx: FeatureContext): boolean => {
		try {
			void ctx.hasUI;
			return true;
		} catch {
			stop();
			return false;
		}
	};
	const report = (ctx: FeatureContext, error: unknown) => {
		if (!live(ctx)) return;
		const message = `Archive persistence: ${errorMessage(error)}`;
		if (reported.has(message)) return;
		reported.add(message);
		if (ctx.hasUI) notify(ctx.ui, message, "warning");
		else process.stderr.write(`${message}\n`);
	};
	api.bus.on("session_start", async (event, ctx) => {
		stop();
		reported.clear();
		const id = activate(ctx.sessionManager, event);
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			// Transcript repair reads session rows and the mirror (machine file); agent events live in the workspace's file.
			const agent = sharedAgentDb();
			const { agent: events, workspace } = workspaceDb(ctx.cwd);
			let busy = 0;
			/** The view file as it was when it proved unusable: no projection until it changes. */
			let foreign: ForeignViewError | undefined;
			let projectedSequence: number | undefined;
			// At most one projection writes at a time; a request meanwhile runs once after it, with the newest events.
			let running: Promise<void> | undefined;
			let again = false;
			const run = (): Promise<void> => {
				running = (async () => {
					try {
						if (foreign && (await viewSignature(foreign.file)) === foreign.signature) return;
						foreign = undefined;
						const sequence = agentEvents.latestSequence(events.db, workspace.id);
						if (sequence === projectedSequence) return;
						await projectAgents(events, workspace.root, workspace);
						projectedSequence = sequence;
						reported.clear();
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
						if (error instanceof ForeignViewError) foreign = error;
						// A lock that never frees warns once; later commits get a fresh quiet retry budget.
						else busy = 0;
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
			unsubscribe = events.onCommit(() => {
				queued ??= {
					timer: setImmediate(() => {
						queued = undefined;
						void project();
					}),
					project,
				};
			});
			events.transaction(() =>
				agentEvents.append(events.db, workspace.id, {
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
	api.bus.on("session_compact", async (event, ctx) => {
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
