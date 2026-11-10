import { textResultDisplay } from "../render/display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import path from "node:path";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../core/features/index.ts";
import { reservationPath, resolveToolPath } from "../shared/home.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import { contentText, firstLine, optionalString, textResult } from "../shared/util.ts";
import { childAsks } from "./asks.ts";
import { EDIT_RETENTION_MINUTES } from "./edits.ts";
import type { ShellParse } from "../shared/shell-commands.ts";
import { registerBreakAttribution } from "./break-attribution.ts";
import { confineNode, registerConfinedNote } from "./node-confine.ts";
import { lockAdvice } from "./lock-advice.ts";
import { plural } from "../shared/text.ts";
import { timedTool, timingOf } from "../render/rows.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { teamWorkspace } from "./store/workspace.ts";
import { checkGoal } from "./identity.ts";
import { describeMembers } from "./member-list.ts";
import { describeChanges, describeConflicts, memberGoals, mutatedPaths } from "./routing.ts";
import type { Team } from "./session.ts";
import { type ChildBudgets, grantRequests } from "./tools/grant.ts";
import {
	INTERPRETER_HELD,
	NOT_CHECKED_HELD,
	PACKAGE_SCRIPT,
	PACKAGE_SCRIPT_NOTE,
	POWERSHELL_HELD,
} from "./tools/held-text.ts";
import { namedReservation } from "./tools/named-reservation.ts";
import { registerTeamEvents } from "./tools/events.ts";
import { type PeerRoute, registerMessageRenderer, registerSendMessageTool } from "./tools/messages.ts";
import { registerRecordedSpend } from "./tools/spend.ts";

const DEFAULT_CHANGES_WINDOW_MIN = 60;
const DEFAULT_CHANGES_LIMIT = 20;

type StopAgent = (id: string, by: string) => string | undefined;
type MergeAgent = (id: string, ctx: ExtensionContext, signal?: AbortSignal) => Promise<{ ok: boolean; text: string }>;
type MergeBranch = (
	branch: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => Promise<{ ok: boolean; text: string }>;

/** Every field the `coordinate` schema accepts: a subagent's schema has no `id` or `goal` (`stop` and `join` are refused there before they are read). */
interface CoordinateParams {
	action: "list" | "join" | "leave" | "lock" | "unlock" | "stop" | "merge" | "grant" | "changes";
	id?: string;
	branch?: string;
	goal?: string;
	paths?: string[];
	withinMinutes?: number;
	limit?: number;
	requests?: number;
	reason?: string;
}

/**
 * Registers the team tools and events; returns the reservation gate for the tool-call pipeline (`index.ts`).
 * `stopAgent` stops a background subagent this session started (wired by `index.ts` from the subagents domain); unset
 * in a subagent, which cannot start any. `beforeLeave` runs at session shutdown before this agent leaves the team:
 * the subagents it stops can still message it and release their reservations while it is a member.
 */
export function registerCollab(
	api: ExtensionAPI,
	team: Team,
	options: {
		stopAgent?: StopAgent;
		/** Lands an isolated child's saved ref (wired by `index.ts` from the subagents domain); unset in a subagent. */
		mergeAgent?: MergeAgent;
		/** Lands a linked worktree's branch in the main checkout (wired by `index.ts`); unset in a subagent. */
		mergeBranch?: MergeBranch;
		/** Other running Octocode sessions, for `message` and `coordinate list` (wired by `index.ts`); unset in a subagent, which reaches only its parent and teammates. */
		peers?: PeerRoute;
		/** The request budgets of the children this agent started (wired by `index.ts` from the subagents domain); unset in a subagent. */
		budgets?: ChildBudgets;
		beforeLeave?: (reason: string) => Promise<unknown>;
		registerTool?: ExtensionAPI["registerTool"];
		/** The paths a bash command writes, as far as a parse can name them (wired by `index.ts` from the permission layer). */
		shellWrites?: (command: string) => Promise<string[]>;
		/** The paths a bash command that ran wrote, only those the parse names (not the guesses `shellWrites` also checks); recorded as changes. */
		shellChanges?: (command: string) => Promise<string[]>;
		/** Whether a shell command (bash, or PowerShell when `shell` says so) only reads (wired by `index.ts` from the permission layer); unset: none is. */
		shellReadOnly?: (command: string, shell?: "bash" | "powershell") => boolean;
		/** The simple commands of a bash command line wherever they run (wired by `index.ts` from the permission layer's parser); unset: a tokenizer reads the line, and a parse that fails refuses any command naming an interpreter. */
		shellCommands?: ShellParse;
	} = {},
): { reservationGate: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined> } {
	registerMessageRenderer(api);
	registerCoordinateTool(api, team, options);
	registerSendMessageTool(api, team, options.registerTool, options.peers);
	registerTeamEvents(api, team, options.beforeLeave, options.shellChanges);
	registerRecordedSpend(api, team);
	registerBreakAttribution(api, team);
	const markConfined = registerConfinedNote(api);
	// Reservations are enforced where the edit happens, so a model that forgot to check cannot overwrite a peer's file with
	// the edit tools, or with a `bash` command whose parse names the path it writes (redirect, `tee`, `rm`, `mv`, `cp`, `sed -i`…).
	// A command whose targets the parse cannot name (`> $FILE`, a script an interpreter runs, `git checkout .`) is not checked.
	// The `file` tool checks each of its queries itself (one held path fails one change, not the whole batch); this covers `bash` writes.
	// A `..` after a symlink stays in the path (`reservationPath`): the shell reads it past the link, not before it.
	const refusal = (file: string, cwd: string) => team.reservation(reservationPath(cwd, file), file);
	const reservationGate = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName === "file") return undefined;
		const input: Record<string, unknown> = isRecord(event.input) ? { ...event.input } : {};
		// No parse names the paths a PowerShell command writes: while another agent holds a reservation, only one that reads runs.
		if (event.toolName === "powershell" || (event.toolName === "bash" && input.type === "powershell")) {
			if (options.shellReadOnly?.(optionalString(input.command) ?? "", "powershell")) return undefined;
			const reason = team.reservation(undefined, "");
			return reason ? { block: true, reason: `${POWERSHELL_HELD} ${reason}` } : undefined;
		}
		let command = event.toolName === "bash" ? optionalString(input.command) : undefined;
		// The same rule for inline interpreter code (`python3 -c`, `node -e`, a heredoc fed to `python -`): its writes are not named
		// either, except for Node under `--permission`, whose runtime refuses them (`interpreterRefusal`); a `node` that lacks
		// only those flags gets them (`confineNode`), and its result says so. Runs only while a reservation is held: the parse is then worth its cost.
		// Inline code is held back only when its text names a reserved path (`namedReservation`): code that names none cannot reach one.
		// A command that is no interpreter run but cannot be read either (a computed program, a wrapper) stays refused.
		const held = command === undefined ? undefined : team.reservation(undefined, "");
		if (command !== undefined && held && !options.shellReadOnly?.(command)) {
			const parse = options.shellCommands;
			const verdict = await confineNode(command, process.env, async (text) =>
				parse ? ((await parse(text)) ?? null) : undefined,
			);
			if (verdict && "refusal" in verdict && !verdict.refusal.interpreter)
				return { block: true, reason: `${NOT_CHECKED_HELD(verdict.refusal)} ${held}` };
			const named = verdict
				? namedReservation(command, ctx.cwd, (absolute, display) => team.reservation(absolute, display))
				: undefined;
			if (verdict && "refusal" in verdict && named)
				return { block: true, reason: `${INTERPRETER_HELD(verdict.refusal)} ${named}` };
			if (verdict && !("refusal" in verdict) && named && isRecord(event.input)) {
				command = verdict.command;
				event.input.command = command;
				markConfined(event.toolCallId);
			}
		}
		if (command !== undefined && held && PACKAGE_SCRIPT.test(command) && !options.shellReadOnly?.(command))
			markConfined(event.toolCallId, PACKAGE_SCRIPT_NOTE);
		const files =
			command !== undefined
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
	api: ExtensionAPI,
	team: Team,
	{
		stopAgent,
		mergeAgent,
		mergeBranch,
		peers,
		budgets,
		registerTool = (tool) => api.registerTool(tool),
	}: {
		stopAgent?: StopAgent | undefined;
		mergeAgent?: MergeAgent | undefined;
		mergeBranch?: MergeBranch | undefined;
		peers?: PeerRoute | undefined;
		budgets?: ChildBudgets | undefined;
		registerTool?: ExtensionAPI["registerTool"] | undefined;
	},
): void {
	// `stop` exists only for an agent that can start subagents, which is also the one that joins and leaves by hand: a
	// subagent joins when it starts and leaves when its run ends (`Team.start`, `onAgentSettled`), and would only be refused `stop`.
	const canStop = stopAgent !== undefined;
	const actions = canStop
		? (["list", "join", "leave", "lock", "unlock", "stop", "merge", "grant", "changes"] as const)
		: (["list", "lock", "unlock", "changes"] as const);
	registerTool(
		timedTool({
			name: "coordinate",
			label: "Coordinate",
			description:
				"List teammates and reserve files. Reservations block conflicting file edits and bash writes to reserved paths; scripts and other editors ignore them. Agents in every git worktree are one team: listed with `· worktree <folder>`, messaged across worktrees. Reservations, `changes` and `.octocode/code/temp/` scratch are per worktree.",
			promptGuidelines: renderInstruction("tools/coordinate/guidelines.md").split("\n"),
			parameters: Type.Object({
				action: StringEnum(actions, {
					description:
						"list: agents and held paths; " +
						(canStop ? "join: set your goal; leave: unregister, release reservations; " : "") +
						"lock: reserve paths, all or none; unlock: release (none given: all); " +
						(canStop
							? "stop: kill a background subagent you started; merge: land an isolated subagent's work here, or a linked worktree's branch in the main checkout (asks the user); grant: add model requests to a running subagent you started, this run only; "
							: "") +
						"changes: recent agent file changes",
				}),
				...(canStop
					? {
							id: Type.Optional(Type.String({ description: "stop, merge, grant: subagent id" })),
							branch: Type.Optional(Type.String({ description: "merge: a linked worktree's branch, instead of id" })),
							requests: Type.Optional(Type.Integer({ description: "grant: model requests to add (positive integer)" })),
						}
					: {}),
				...(canStop
					? { goal: Type.Optional(Type.String({ description: "join: your goal, worded as a task goal" })) }
					: {}),
				paths: Type.Optional(
					Type.Array(Type.String(), {
						description: 'lock/unlock: files or "dir/". changes: only under these paths',
					}),
				),
				withinMinutes: Type.Optional(Type.Integer({ description: "changes: window in minutes (default 60)" })),
				limit: Type.Optional(Type.Integer({ description: "changes: max files (default 20)" })),
				// The unified `agent` tool passes its call `reason` here: the lock note others see.
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
					if (!result.ok) throw new Error(describeConflicts(result.conflicts, now, memberGoals(team.members())));
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
					const refused = stopAgent(id?.trim() ?? "", team.id ?? "the coordinator");
					if (refused) throw new Error(refused);
					return textResult(`Stopping ${id}: its process tree is killed and its report arrives as a message.`);
				} else if (params.action === "merge" && params.branch !== undefined) {
					if (!mergeBranch) throw new Error("Only the session in the main checkout can merge a worktree's branch.");
					const result = await mergeBranch(params.branch.trim(), ctx, signal);
					if (!result.ok) throw new Error(result.text);
					return textResult(result.text);
				} else if (params.action === "merge") {
					if (!mergeAgent) throw new Error("Only the agent that started a subagent can merge its work.");
					const id = params.id?.trim();
					if (!id) throw new Error("merge needs the id of an isolated subagent.");
					const result = await mergeAgent(id, ctx, signal);
					if (!result.ok) throw new Error(result.text);
					return textResult(result.text);
				} else if (params.action === "grant") {
					return grantRequests(team, budgets, params.id, params.requests, signal);
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
				const asks = childAsks(members, team.id, (child, parent, since) => team.asks(child, parent, since));
				const standing = (id: string) => budgets?.usage(id);
				const details = team.audit.details(members);
				const agents = describeMembers(
					members,
					team.id,
					now,
					asks,
					team.openQuestions(),
					standing,
					team.stalled(),
					details,
				);
				const others = peers ? `\n\n${await peers.list(ctx.cwd)}` : "";
				return textResult(`${agents}${others}`, {
					summary: members.length ? `${plural(members.length, "agent")} · ${working} working` : "No agents",
				});
			},
			display(input) {
				const { args } = input;
				const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
				const { id, goal, requests } = args as Partial<CoordinateParams>;
				const summary = [
					/* oxlint-disable typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders */
					String(args.action ?? ""),
					id === undefined ? "" : String(id),
					requests === undefined ? "" : `+${String(requests)}`,
					paths.length > 1 ? plural(paths.length, "path") : (paths[0] ?? ""),
					goal ? `"${String(goal)}"` : "",
					/* oxlint-enable typescript/no-unnecessary-type-conversion */
				]
					.filter(Boolean)
					.join(" ");
				const stated = isRecord(input.result?.details) && typeof input.result.details.summary === "string";
				return textResultDisplay(
					{
						title: "Coordinate",
						summary,
						kind: "agent",
						...(paths.length ? { locations: paths.map((path) => ({ path })) } : {}),
						blocks: [],
					},
					input,
					stated ? { summary: (input.result!.details as { summary: string }).summary, keepBody: true } : {},
				);
			},
			renderCall(args, theme, context) {
				const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
				const target = paths.length > 1 ? plural(paths.length, "path") : (paths[0] ?? "");
				const { id, goal, requests } = args as Partial<CoordinateParams>;
				const summary = [
					/* oxlint-disable typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders */
					String(args.action ?? ""),
					id === undefined ? "" : String(id),
					requests === undefined ? "" : `+${String(requests)}`,
					target,
					goal ? `"${String(goal)}"` : "",
					/* oxlint-enable typescript/no-unnecessary-type-conversion */
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
