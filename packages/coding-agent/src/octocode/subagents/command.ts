import type { CommandContext } from "../../core/features/index.ts";
import { agentDetailText, recentRunsText } from "./run-text.ts";
import { cancelledText, type Subcommand, say, wordCompletions } from "../shared/commands.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { USER_STOP } from "./process/outcome.ts";
import { type Ask, UserQuestions } from "../team/asks.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describeMembers } from "../team/member-list.ts";
import type { Team } from "../team/session.ts";
import type { BudgetStanding } from "../team/model.ts";
import { sessionChildren } from "../child-sessions/session-children.ts";
import { describeChild } from "./children.ts";
import { agentStats, renderStats } from "./stats.ts";
import { discardChild, landChild } from "./merge-child.ts";
import { pendingRefs } from "./worktree.ts";
import { findMember } from "./detail/lookup.ts";
import { memberTone, openAgent, pickAgent } from "./detail/page.ts";
import { activityBadge } from "../../theme/page-kit.ts";
import { currentActivity } from "../activity/session-activity.ts";

/** Running subagents by id (background, or foreground for `/agents kill`). `stoppedBy`: who stopped it (`user`, or the id of the agent that started it). */
export interface BackgroundRun {
	controller: AbortController;
	done: Promise<void>;
	stoppedBy?: string;
}
export type Background = Map<string, BackgroundRun>;

const AGENTS_USAGE =
	"Usage: /agents [tell <agent|all> [#<message to answer>] <message> | interrupt <id> <message> | kill <id> | merge <id> | discard <id> | stats | history | external ...]";
const AGENTS_SUBCOMMANDS: Array<[string, string]> = [
	[
		"tell",
		"tell <agent|all> [#<message to answer>] <message> — message an agent, or every agent of this session; #n answers its question",
	],
	["interrupt", "interrupt <id> <message> — stop a subagent's current step and continue it with the message"],
	["kill", "kill <id> — stop a running subagent"],
	["merge", "merge <id> — merge an isolated subagent into this tree"],
	["discard", "discard <id> — delete an isolated subagent's unmerged result"],
	["stats", "stats — this session's subagent runs per profile: outcomes, tokens, cost, asks, compactions"],
	["history", "history — every subagent this session started: profile, goal, status, transcript and report"],
];

/** Stops a running subagent (its whole process tree); its report then says who stopped it. */
export function stopBackground(
	background: Background,
	id: string,
	by: string,
	kind = "background subagent",
): string | undefined {
	const entry = background.get(id);
	if (!entry) {
		const ids = [...background.keys()];
		return `${id ? `No ${kind} "${id}".` : `Name the ${kind} to stop.`} ${ids.length ? `Running: ${ids.join(", ")}` : "None is running."}`;
	}
	entry.stoppedBy ??= by;
	// The user's stop gets the short grace: the row frees at once.
	entry.controller.abort(by === USER_SENDER ? USER_STOP : undefined);
	return undefined;
}

/**
 * `/agents` lists the agents; `tell`, `kill` and `merge` act on one. `kill` stops a
 * background subagent, or a foreground one (`foreground`) whose call then returns that the user stopped it.
 */
export function agentsCommand(
	team: Team,
	background: Background,
	foreground: Background = new Map(),
	questions = new UserQuestions(),
	standing?: (id: string) => BudgetStanding | undefined,
): Subcommand {
	/** Each listed subagent's questions to its parent since it joined, with their answers. */
	const asksOf = (members: readonly Member[]): Map<string, Ask[]> =>
		new Map(
			members.flatMap((member) =>
				member.parentId
					? [[member.id, questions.mark(team.asks(member.id, member.parentId, member.joinedAt))] as const]
					: [],
			),
		);
	const running = () => [...background.keys(), ...foreground.keys()];
	const tell = async (args: string, ctx: CommandContext, interrupt = false) => {
		const to = args.split(/\s+/, 1)[0] ?? "";
		const rest = args.slice(to.length).trim();
		// `#12 …` answers message 12: that closes the agent's question.
		const answering = interrupt ? null : /^#(\d+)\s+/.exec(rest);
		const text = answering ? rest.slice(answering[0].length) : rest;
		if (!to || !text)
			return say(
				ctx,
				interrupt
					? "Usage: /agents interrupt <id> <message>"
					: "Usage: /agents tell <agent|all> [#<message to answer>] <message>",
				"warning",
			);
		try {
			const result = await team.send(to, text, {
				from: USER_SENDER,
				replyRequired: false,
				...(answering ? { replyTo: Number(answering[1]) } : {}),
				...(interrupt ? { interrupt } : {}),
			});
			const done =
				"error" in result
					? result.error
					: (result.resumed ?? `${interrupt ? "Interrupt queued for" : "Queued for"} ${result.sent.join(", ")}`);
			say(ctx, done, "error" in result ? "warning" : "info");
		} catch (error) {
			say(ctx, errorMessage(error), "warning");
		}
	};
	const kill = async (id: string, ctx: CommandContext) => {
		const ids = running();
		// The report that follows says the run ended; what the stop cost it cannot be undone, so someone at the keyboard is asked.
		if (
			ctx.hasUI &&
			ids.includes(id) &&
			!(await ctx.ui.confirm("Stop subagent?", `Stop ${id}? Work it has not reported is lost.`))
		)
			return say(ctx, cancelledText("stopped"));
		const refused = !id
			? `Usage: /agents kill <id>. ${ids.length ? `Running: ${ids.join(", ")}` : "None is running."}`
			: foreground.has(id)
				? stopBackground(foreground, id, USER_SENDER, "subagent")
				: background.has(id) || ids.length === 0
					? stopBackground(background, id, USER_SENDER, "subagent")
					: `No running subagent "${id}". Running: ${ids.join(", ")}`;
		say(ctx, refused ?? `Stopping ${id}…`, refused ? "warning" : "info");
	};
	const merge = async (id: string, ctx: CommandContext) => {
		if (!id) {
			const ids = await pendingRefs(ctx.cwd);
			return say(
				ctx,
				`Usage: /agents merge <id>. ${ids.length ? `Unmerged: ${ids.join(", ")}` : "No isolated results to merge."}`,
				"warning",
			);
		}
		try {
			// A merge writes files like any other writer: another agent's reservation stops it unless the user, asked, overrides it.
			const result = await landChild(team, id, ctx, (listed) =>
				ctx.hasUI ? ctx.ui.confirm(`Merge ${id} over reservations?`, listed) : Promise.resolve(false),
			);
			say(ctx, result.text, result.reserved ? "warning" : result.ok ? "info" : "error");
		} catch (error) {
			say(ctx, errorMessage(error), "error");
		}
	};
	const discard = async (id: string, ctx: CommandContext) => {
		if (!id) {
			const ids = await pendingRefs(ctx.cwd);
			return say(
				ctx,
				`Usage: /agents discard <id>. ${ids.length ? `Unmerged: ${ids.join(", ")}` : "No isolated results to discard."}`,
				"warning",
			);
		}
		try {
			// The work cannot be recovered, so without someone to ask nothing is deleted.
			const result = await discardChild(team, id, ctx, (ref, files) =>
				ctx.hasUI
					? ctx.ui.confirm(
							`Discard ${ref}?`,
							`Its ${files.length} changed file${files.length === 1 ? "" : "s"} are lost:\n${files.slice(0, 10).join("\n")}${files.length > 10 ? `\n(${files.length - 10} more)` : ""}`,
						)
					: Promise.resolve(false),
			);
			say(ctx, result.text, result.ok ? "info" : "warning");
		} catch (error) {
			say(ctx, errorMessage(error), "error");
		}
	};
	// Completions are synchronous: unmerged refs come from the last lookup, refreshed on every completion request.
	let cwd = process.cwd();
	let refs: string[] = [];
	let looking = false;
	const refreshRefs = () => {
		if (looking) return;
		looking = true;
		void pendingRefs(cwd)
			.then(
				(found) => {
					refs = found;
					return refs;
				},
				() => undefined,
			)
			.finally(() => {
				looking = false;
				return looking;
			});
	};
	const ids = (sub: string): string[] => {
		if (sub === "kill") return running();
		if (sub === "merge" || sub === "discard") {
			refreshRefs();
			return refs;
		}
		const members = team.view.members.length > 0 ? team.view.members : team.members();
		if (sub === "interrupt")
			return members.filter((member) => member.parentId !== undefined).map((member) => member.id);
		return [...members.map((member) => member.id).filter((id) => id !== team.id), "all"];
	};
	return {
		description: "List, message or stop subagents",
		argumentHint:
			"[tell <agent|all> <message> | interrupt <id> <message> | kill <id> | merge <id> | discard <id> | stats | history]",
		complete: (prefix) => {
			const space = prefix.indexOf(" ");
			if (space === -1)
				return (
					wordCompletions(AGENTS_SUBCOMMANDS, prefix)?.map((item) => ({ ...item, value: `${item.value} ` })) ?? null
				);
			const sub = prefix.slice(0, space);
			const rest = prefix.slice(space + 1).trimStart();
			if (sub === "stats" || sub === "history" || !AGENTS_SUBCOMMANDS.some(([name]) => name === sub) || /\s/.test(rest))
				return null;
			const items = wordCompletions(ids(sub), rest);
			return (
				items?.map((item) => ({
					...item,
					value: `${sub} ${item.value}${sub === "tell" || sub === "interrupt" ? " " : ""}`,
				})) ?? null
			);
		},
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			const line = args.trim();
			const sub = line.split(/\s+/, 1)[0] ?? "";
			const rest = line.slice(sub.length).trim();
			if (sub === "tell") return tell(rest, ctx);
			if (sub === "interrupt") return tell(rest, ctx, true);
			if (sub === "kill") return kill(rest, ctx);
			if (sub === "merge") return merge(rest, ctx);
			if (sub === "discard") return discard(rest, ctx);
			if (sub === "stats") return say(ctx, renderStats(agentStats(ctx.sessionManager.getEntries())));
			if (sub === "history") {
				const children = sessionChildren(ctx.sessionManager.getEntries());
				return say(ctx, children.length > 0 ? children.map(describeChild).join("\n") : "No subagents in this session.");
			}
			if (sub) {
				// Any other word names an agent, live or past: its name, session, registration, process, pid or backlog item.
				// A live agent by name or unique prefix opens its page; otherwise the audit finds past agents by any reference.
				const live = findMember(team.members(), line);
				if ("member" in live) return openAgent(team, live.member.id, ctx);
				const found = team.audit.resolve(line);
				return found ? say(ctx, agentDetailText(found)) : say(ctx, `${live.error}\n${AGENTS_USAGE}`, "warning");
			}
			// The picker lists every agent of this repository; alone, the listing (this session, recent runs) says more.
			if (ctx.hasUI && team.members().some((member) => member.id !== team.id)) return pickAgent(team, ctx);
			const { members, error } = team.snapshot();
			// The same inputs as `coordinate list`: one renderer; this full view adds the log folders, pid and token counts.
			const listing = describeMembers(
				members,
				team.id,
				Date.now(),
				asksOf(members),
				team.openQuestions(),
				standing,
				team.stalled(),
				team.audit.details(members),
			);
			// A run that has not ended says what its agent does now: this session by its own light, a member by its row.
			const recent = recentRunsText(team.audit.recent(), Date.now(), (run) => {
				if (run.agentId === team.id) return currentActivity(ctx.sessionManager.getSessionId()).label;
				const member = members.find((candidate) => candidate.id === run.agentId);
				return member && activityBadge(memberTone(member)).word;
			});
			say(ctx, error ? `${error}\n${listing}` : `${listing}${recent}`, error ? "warning" : "info");
		},
	};
}
