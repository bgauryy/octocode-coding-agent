import { HistoryRepair } from "./repair.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { agentEvents, sharedAgentDb } from "../agentdb/api.ts";
import { activate, activationId } from "../shared/activation.ts";
import { sessionWorkspace } from "../shared/home/workspace.ts";
import { notify } from "../shared/commands.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { projectAgents } from "./projection.ts";
import { saveCompaction, writeSummaryLibrary } from "./summaries.ts";

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
	const report = (ctx: ExtensionContext, error: unknown) => {
		const message = `Archive persistence: ${errorMessage(error)}`;
		if (message === lastProblem) return;
		lastProblem = message;
		if (ctx.hasUI) notify(ctx.ui, message, "warning");
		else process.stderr.write(`${message}\n`);
	};
	api.on("session_start", async (event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		const id = activate(ctx.sessionManager, event);
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			const agent = sharedAgentDb();
			const workspace = sessionWorkspace(ctx.cwd);
			const project = () => {
				if (!options.canProject()) return;
				try {
					projectAgents(agent, workspace);
					lastProblem = undefined;
				} catch (error) {
					report(ctx, error);
				}
			};
			unsubscribe = agent.onCommit(project);
			agent.transaction(() =>
				agentEvents.append(agent.db, workspace, {
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
			saveCompaction(agent, sessionWorkspace(ctx.cwd), sessionId, event.compactionEntry, {
				transcript,
				activationId: activationId(ctx.sessionManager),
				agentId: options.agentId(),
			});
			await writeSummaryLibrary(agent, sessionId);
		} catch (error) {
			report(ctx, error);
		}
	});
	return () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
}
