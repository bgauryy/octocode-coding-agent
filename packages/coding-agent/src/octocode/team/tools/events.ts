import { type ExtensionAPI, readsMessagesOnly } from "../../../core/features/index.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { modelLookup, optionalString, unpricedModel } from "../../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { unjoinedAgent } from "../edits.ts";
import { modelRoute } from "../identity.ts";
import type { Team } from "../session.ts";
import { teamNameToResume } from "../session/rejoin.ts";

/** The session events the team follows: its membership, activity, mail delivery and the record of who changed which file. */
export function registerTeamEvents(
	api: ExtensionAPI,
	team: Team,
	beforeLeave?: (reason: string) => Promise<unknown>,
	shellChanges?: (command: string) => Promise<string[]>,
): void {
	api.on("session_start", async (event, ctx) =>
		team.start(ctx, teamNameToResume(ctx.sessionManager.getBranch(), event.reason)),
	);
	api.on("session_shutdown", async (event) => {
		try {
			// The shutdown's reason (`reload`, `quit`…) names what stopped the subagents in their reports.
			await beforeLeave?.(event.reason);
		} finally {
			team.stop();
		}
	});
	api.on("agent_start", async () => team.onAgentStart());
	api.on("agent_settled", async (event) => team.onAgentSettled(event.outcome?.status));
	// The loop reads queued steering right after `turn_end`: mail that arrived while the tools ran joins the next request
	// instead of waiting for the tick. A final turn (no tools) is left to the tick, so waiting mail adds no model call.
	api.on("turn_end", async (event) => {
		if (event.toolResults.length > 0) team.deliverMail(true);
		return undefined;
	});
	// Team mail is delivered when the model is called with it. Octocode emits `context` before every model call, whichever way
	// a message entered the conversation (message_start reaches extensions only for steered and prompted messages).
	api.on(
		"context",
		readsMessagesOnly(async (event) => {
			team.onContext(event.messages);
			return undefined;
		}),
	);
	// Mail that reached the transcript and was then compacted away is carried by the summary: no later `context` event
	// lists it, so it would stay unseen and hold back newer mail. Mail in the kept range is still seen by the next call.
	api.on("session_compact", async (event, ctx) => {
		const summarized: Array<{ role: "custom"; customType: string; details: unknown }> = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.id === event.compactionEntry.firstKeptEntryId || entry.id === event.compactionEntry.id) break;
			if (entry.type === "custom_message")
				summarized.push({ role: "custom", customType: entry.customType, details: entry.details });
		}
		team.onContext(summarized);
		return undefined;
	});
	// Who changed which file, for `coordinate changes`: `file` by its outcomes (a batch can partly fail), `bash` by the
	// paths its parse names. A command is only on the start event, so it waits here for the end; a blocked or failed call
	// ends as an error and records nothing.
	const commands = new Map<string, string>();
	api.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) team.onToolStart();
		if (event.toolName === "bash" && shellChanges && isRecord(event.args) && event.args.type !== "powershell") {
			const command = optionalString(event.args.command);
			if (command !== undefined) commands.set(event.toolCallId, command);
		}
	});
	api.on("tool_execution_end", async (event, ctx) => {
		const command = commands.get(event.toolCallId);
		commands.delete(event.toolCallId);
		// A `file` batch in which a query failed is an error result; its outcomes still name the changes it applied.
		if (event.isError && event.toolName !== "file") return;
		let written: string[] = [];
		if (command !== undefined) {
			try {
				written = (await shellChanges?.(command)) ?? [];
			} catch {
				// A command the parse cannot read records nothing.
			}
		}
		const outcomes =
			event.toolName === "file" && isRecord(event.result) && isRecord(event.result.details)
				? event.result.details.outcomes
				: undefined;
		const files = Array.isArray(outcomes)
			? outcomes.flatMap((outcome) =>
					isRecord(outcome) && outcome.ok === true && typeof outcome.path === "string" ? [outcome.path] : [],
				)
			: written;
		if (files.length === 0) return;
		try {
			team.editLog()?.record(
				team.id ?? unjoinedAgent(),
				event.toolName,
				files.map((file) => resolveToolPath(ctx.cwd, file)),
			);
		} catch {
			// A missing record only makes `coordinate changes` less complete.
		}
	});
	// `provider/id:thinking`: `coordinate list` and the panel show every agent's route and effort, so a coordinator sees what each child runs on.
	api.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const { provider, model } = event.message;
		const same = ctx.model?.id === model ? ctx.model : undefined;
		team.onUsage(
			event.message.usage,
			model ? modelRoute({ provider, id: model, reasoning: same?.reasoning }, api.getThinkingLevel()) : undefined,
			unpricedModel(event.message, modelLookup(ctx)) !== undefined,
		);
	});
	api.on("model_select", async (event) => {
		team.setModel(modelRoute(event.model, api.getThinkingLevel()));
	});
	api.on("thinking_level_select", async (event, ctx) => {
		team.setModel(modelRoute(ctx.model, event.level));
	});
}
