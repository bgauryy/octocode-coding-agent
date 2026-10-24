import path from "node:path";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/index.ts";
import { resolveToolPath } from "../shared/home.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { storedText } from "../shared/sanitize.ts";
import { contentText, firstLine, modelLookup, optionalString, textResult, unpricedModel } from "../shared/util.ts";
import { EDIT_RETENTION_MINUTES } from "./edits.ts";
import { lockAdvice } from "./lock-advice.ts";
import { plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { isRecord } from "../../utils/guards.ts";
import { teamWorkspace } from "./store/workspace.ts";
import { checkGoal, GOAL_DESCRIPTION } from "./identity.ts";
import { describeChanges, describeConflicts, describeMembers, mutatedPaths } from "./routing.ts";
import type { Team } from "./session.ts";
import { registerMessageRenderer, registerSendMessageTool } from "./tools/messages.ts";

const DEFAULT_CHANGES_WINDOW_MIN = 60;
const DEFAULT_CHANGES_LIMIT = 20;

type StopAgent = (id: string, by: string) => string | undefined;

/** Every field the `coordinate` schema accepts: a subagent's schema has no `id` or `goal` (`stop` and `join` are refused there before they are read). */
interface CoordinateParams {
	action: "list" | "join" | "leave" | "lock" | "unlock" | "stop" | "changes";
	id?: string;
	goal?: string;
	paths?: string[];
	withinMinutes?: number;
	limit?: number;
	reason?: string;
}

/**
 * Registers the team tools and events; returns the reservation gate for the tool-call pipeline (`index.ts`).
 * `stopAgent` stops a background subagent this session started (wired by `index.ts` from the subagents domain); unset
 * in a subagent, which cannot start any. `beforeLeave` runs at session shutdown before this agent leaves the team:
 * the subagents it stops can still message it and release their reservations while it is a member.
 */
export function registerCollab(
	pi: ExtensionAPI,
	team: Team,
	options: {
		stopAgent?: StopAgent;
		beforeLeave?: (reason: string) => Promise<unknown>;
		registerTool?: ExtensionAPI["registerTool"];
		/** The paths a bash command writes, as far as a parse can name them (wired by `index.ts` from the permission layer). */
		shellWrites?: (command: string) => Promise<string[]>;
	} = {},
): { reservationGate: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined> } {
	registerMessageRenderer(pi);
	registerCoordinateTool(pi, team, options.stopAgent, options.registerTool);
	registerSendMessageTool(pi, team, options.registerTool);
	registerTeamEvents(pi, team, options.beforeLeave);
	// Reservations are enforced where the edit happens, so a model that forgot to check cannot overwrite a peer's file with
	// the edit tools, or with a `bash` command whose parse names the path it writes (redirect, `tee`, `rm`, `mv`, `cp`, `sed -i`…).
	// A command whose targets the parse cannot name (`> $FILE`, a script an interpreter runs, `git checkout .`) is not checked.
	// The `file` tool checks each of its queries itself (one held path fails one change, not the whole batch); this covers Octocode's own edit and write.
	const refusal = (file: string, cwd: string) => team.reservation(resolveToolPath(cwd, file), file);
	const reservationGate = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName === "file") return undefined;
		const command =
			event.toolName === "bash" ? optionalString((event.input as Record<string, unknown>)?.command) : undefined;
		const files =
			command !== undefined && (event.input as Record<string, unknown>).type !== "powershell"
				? ((await options.shellWrites?.(command)) ?? [])
				: mutatedPaths(event.toolName, event.input);
		for (const file of files) {
			const reason = refusal(file, ctx.cwd);
			if (reason) return { block: true, reason };
		}
		return undefined;
	};
	return { reservationGate };
}

function registerCoordinateTool(
	pi: ExtensionAPI,
	team: Team,
	stopAgent: StopAgent | undefined,
	registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(tool),
): void {
	// `stop` exists only for an agent that can start subagents, which is also the one that joins and leaves by hand: a
	// subagent joins when it starts and leaves when its run ends (`Team.start`, `onAgentSettled`), and would only be refused `stop`.
	const canStop = stopAgent !== undefined;
	const actions = canStop
		? (["list", "join", "leave", "lock", "unlock", "stop", "changes"] as const)
		: (["list", "lock", "unlock", "changes"] as const);
	registerTool(
		timedTool({
			name: "coordinate",
			label: "Coordinate",
			description:
				"List teammates and reserve files. Reservations block conflicting file edits and bash writes to reserved paths; scripts and other editors ignore them.",
			promptGuidelines: [
				"Before edits that may overlap another agent's, use coordinate: list agents, lock your edit paths, then unlock when done. Resolve conflicts with the owner.",
			],
			parameters: Type.Object({
				action: StringEnum(actions, {
					description:
						"list: live agents and held paths; " +
						(canStop ? "join: register or update your goal; leave: unregister and release reservations; " : "") +
						"lock: reserve paths, all or none; unlock: release paths, or all without paths; " +
						(canStop ? "stop: kill a background subagent you started (id); " : "") +
						"changes: recent file changes by agents, newest first",
				}),
				...(canStop
					? { id: Type.Optional(Type.String({ description: "stop: id of the background subagent to end" })) }
					: {}),
				...(canStop
					? { goal: Type.Optional(Type.String({ description: `join: your goal. ${GOAL_DESCRIPTION}` })) }
					: {}),
				paths: Type.Optional(
					Type.Array(Type.String(), {
						description: 'lock/unlock: files, or "dir/" for a tree. changes: only under these paths',
					}),
				),
				withinMinutes: Type.Optional(Type.Integer({ description: "changes: window in minutes (default 60)" })),
				limit: Type.Optional(Type.Integer({ description: "changes: max files (default 20)" })),
				reason: Type.Optional(Type.String({ description: "lock: what you will change there" })),
			}),
			async execute(_id, input, signal, _onUpdate, ctx) {
				// The schema's optional `id` and `goal` depend on the agent, so Octocode infers them as unknown: this is the one place that names them.
				const params = input as CoordinateParams;
				signal?.throwIfAborted();
				const now = Date.now();
				if (params.action === "join") team.join(params.goal ? checkGoal(params.goal) : undefined);
				else if (params.action === "leave") {
					team.leave();
					return textResult("Left the team.");
				} else if (params.action === "lock") {
					if (!params.paths?.length) throw new Error("lock needs paths.");
					const result = team.lock(params.paths, storedText(params.reason, 200) || "editing");
					if (!result.ok) throw new Error(describeConflicts(result.conflicts, now));
					const total =
						result.held > result.leases.length ? ` You now hold ${plural(result.held, "reservation")}.` : "";
					const mine = team.snapshot().members.find((member) => member.id === team.id)?.locks ?? [];
					const advice = lockAdvice(teamWorkspace(ctx.cwd), mine);
					return textResult(
						`Reserved: ${result.leases.map((lease) => (lease.kind === "tree" ? `${lease.path}/` : lease.path)).join(", ")}.${total} Unlock when your edits are done.${advice}`,
						{ summary: `Reserved ${plural(result.leases.length, "path")}` },
					);
				} else if (params.action === "unlock") {
					const released = team.unlock(params.paths);
					return textResult(`Released ${released} reservation(s).`, {
						summary: `Released ${plural(released, "reservation")}`,
					});
				} else if (params.action === "stop") {
					if (!stopAgent)
						throw new Error("Only the agent that started a subagent can stop it, and you have started none.");
					const id = params.id;
					const refused = stopAgent(id?.trim() ?? "", team.id ?? "the parent agent");
					if (refused) throw new Error(refused);
					return textResult(`Stopping ${id}: its process tree is killed and its report arrives as a message.`);
				} else if (params.action === "changes") {
					const requested = Math.max(1, Math.floor(params.withinMinutes ?? DEFAULT_CHANGES_WINDOW_MIN));
					// Changes older than the retention are gone: search what is kept and say so (describeChanges).
					const minutes = Math.min(requested, EDIT_RETENTION_MINUTES);
					const log = team.editLog();
					const prefixes =
						log &&
						params.paths?.map((entry) =>
							path.relative(log.workspace, resolveToolPath(ctx.cwd, entry)).split(path.sep).join("/"),
						);
					const changes = log?.changes({ withinMs: minutes * 60_000, ...(prefixes?.length ? { prefixes } : {}) }) ?? [];
					const text = describeChanges(
						changes,
						{
							self: team.id,
							minutes,
							requested,
							limit: Math.max(1, Math.floor(params.limit ?? DEFAULT_CHANGES_LIMIT)),
							paths: params.paths,
						},
						now,
					);
					return textResult(text, {
						summary: changes.length
							? `${plural(changes.length, "file")} changed in ${minutes}m`
							: `No changes in ${minutes}m`,
					});
				}
				const { members, error } = team.snapshot();
				if (error) throw new Error(error);
				const working = members.filter((member) => member.status === "working").length;
				return textResult(describeMembers(members, team.id, now), {
					summary: members.length ? `${plural(members.length, "agent")} · ${working} working` : "No agents",
				});
			},
			renderCall(args, theme, context) {
				const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
				const target = paths.length > 1 ? plural(paths.length, "path") : (paths[0] ?? "");
				const { id, goal } = args as Partial<CoordinateParams>;
				const summary = [
					String(args.action ?? ""),
					id === undefined ? "" : String(id),
					target,
					goal ? `"${String(goal)}"` : "",
				]
					.filter(Boolean)
					.join(" ");
				return toolHeader(theme, context, "Coordinate", summary);
			},
			renderResult(result, _options, theme, context) {
				const body = contentText(result.content);
				const summary =
					isRecord(result.details) && typeof result.details.summary === "string"
						? result.details.summary
						: firstLine(body);
				// The agent list and change log stay folded: the summary counts them and ctrl+o shows them.
				return resultBlock(theme, context, {
					summary,
					body: summary === firstLine(body) ? body.split("\n").slice(1).join("\n") : body,
					max: context.isError ? 3 : 0,
					...timingOf(result.details),
				});
			},
		}),
	);
}

function registerTeamEvents(pi: ExtensionAPI, team: Team, beforeLeave?: (reason: string) => Promise<unknown>): void {
	pi.on("session_start", async (_event, ctx) => team.start(ctx));
	pi.on("session_shutdown", async (event) => {
		try {
			// The shutdown's reason (`reload`, `quit`…) names what stopped the subagents in their reports.
			await beforeLeave?.(event.reason);
		} finally {
			team.stop();
		}
	});
	pi.on("agent_start", async () => team.onAgentStart());
	pi.on("agent_settled", async () => team.onAgentSettled());
	// Team mail is delivered when the model is called with it. Octocode emits `context` before every model call, whichever way
	// a message entered the conversation (message_start reaches extensions only for steered and prompted messages).
	pi.on("context", async (event) => {
		team.onContext(event.messages);
		return undefined;
	});
	// Mail that reached the transcript and was then compacted away is carried by the summary: no later `context` event
	// lists it, so it would stay unseen and hold back newer mail. Mail in the kept range is still seen by the next call.
	pi.on("session_compact", async (event, ctx) => {
		const summarized: Array<{ role: "custom"; customType: string; details: unknown }> = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.id === event.compactionEntry.firstKeptEntryId || entry.id === event.compactionEntry.id) break;
			if (entry.type === "custom_message")
				summarized.push({ role: "custom", customType: entry.customType, details: entry.details });
		}
		team.onContext(summarized);
		return undefined;
	});
	// Who changed which file, for `coordinate changes`: Octocode's edit/write by their arguments, `file` by its outcomes (a
	// batch can partly fail). Arguments are only on the start event, so they wait here for the end.
	const pending = new Map<string, string[]>();
	pi.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) team.onToolStart();
		if (event.toolName === "edit" || event.toolName === "write")
			pending.set(event.toolCallId, mutatedPaths(event.toolName, event.args));
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		const args = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (event.isError) return;
		const outcomes =
			event.toolName === "file" && isRecord(event.result) && isRecord(event.result.details)
				? event.result.details.outcomes
				: undefined;
		const files = Array.isArray(outcomes)
			? outcomes.flatMap((outcome) =>
					isRecord(outcome) && outcome.ok === true && typeof outcome.path === "string" ? [outcome.path] : [],
				)
			: (args ?? []);
		if (files.length === 0) return;
		try {
			team.editLog()?.record(
				team.id ?? `pid ${process.pid}`,
				event.toolName,
				files.map((file) => resolveToolPath(ctx.cwd, file)),
			);
		} catch {
			// A missing record only makes `coordinate changes` less complete.
		}
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant")
			team.onUsage(
				event.message.usage,
				event.message.model,
				unpricedModel(event.message, modelLookup(ctx)) !== undefined,
			);
	});
}
