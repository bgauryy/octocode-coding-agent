import { HistoryRepair } from "./repair.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { agentEvents } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { activate, activationId } from "../shared/activation.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import { notify } from "../shared/commands.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
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
	const stop = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (retry) clearTimeout(retry);
		retry = undefined;
	};
	const report = (ctx: ExtensionContext, error: unknown) => {
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
			const project = () => {
				if (!options.canProject()) return;
				try {
					const sequence = agentEvents.latestSequence(agent.db, workspace.id);
					if (sequence === projectedSequence) return;
					projectAgents(agent, workspace.root, workspace);
					projectedSequence = sequence;
					lastProblem = undefined;
					busy = 0;
				} catch (error) {
					// Another process is writing the same generated view; the events are already committed. Project again
					// shortly (one pending retry, however many commits arrive) and warn only when the lock never frees.
					if (isRecord(error) && error.code === "ELOCKED" && busy < PROJECTION_RETRIES) {
						busy += 1;
						retry ??= setTimeout(() => {
							retry = undefined;
							project();
						}, PROJECTION_RETRY_MS);
						retry.unref?.();
						return;
					}
					report(ctx, error);
				}
			};
			unsubscribe = agent.onCommit(project);
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
			await new HistoryRepair(agent).transcript(file);
			project();
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
			saveCompaction(agent, ctx.cwd, sessionId, event.compactionEntry, {
				transcript,
				activationId: activationId(ctx.sessionManager),
				agentId: options.agentId(),
			});
			await writeSummaryLibrary(agent, sessionId, process.env, ctx.cwd);
		} catch (error) {
			report(ctx, error);
		}
	});
	return stop;
}
