import path from "node:path";
import { renderPrompt } from "../../core/prompt-template.ts";
import { type Backlog, openBacklog } from "../backlog/context.ts";
import { checkDelegable, claimDelegated } from "../backlog/delegation.ts";
import type { Item } from "../backlog/item.ts";
import { formatTokens } from "../shared/format.ts";
import type { Handoff } from "../team/tools/hand.ts";
import type { AgentRuns } from "./claim.ts";
import type { Lingering } from "./linger.ts";
import { refuseSecondChild } from "./second-child.ts";

/** Share of its model's window at which a handoff warns that the child is near full. */
export const CONTEXT_WARN_SHARE = 0.7;

/** A running child's context: what its latest model request carried and its model's window, when known. */
export interface ChildContext {
	used: number;
	window?: number;
}

/** The context of running child `id`, from its latest reply; undefined before its first reply or once it ended. */
export function contextOf(runs: Pick<AgentRuns, "running" | "live">, id: string): ChildContext | undefined {
	if (!runs.running.has(id)) return undefined;
	const details = runs.live.get(id);
	if (details?.contextTokens === undefined) return undefined;
	return { used: details.contextTokens, ...(details.contextWindow ? { window: details.contextWindow } : {}) };
}

/** `context 45% (90k of 200k)`, or `context 90k` when the window is unknown. */
export function contextText({ used, window }: ChildContext): string {
	if (!window) return `context ${formatTokens(used)}`;
	return `context ${Math.round((used / window) * 100)}% (${formatTokens(used)} of ${formatTokens(window)})`;
}

/** The paths `item` shares with `other`: equal, or one inside the other. */
function sharedPaths(item: Pick<Item, "paths">, other: Pick<Item, "paths"> | undefined): string[] {
	if (!other) return [];
	const inside = (a: string, b: string) => {
		const rel = path.relative(path.normalize(b), path.normalize(a));
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	};
	return item.paths.filter((entry) => other.paths.some((own) => inside(entry, own) || inside(own, entry)));
}

type HandRuns = Pick<AgentRuns, "running" | "items" | "live" | "handed">;

/**
 * `agent` `message` with `item`: hands a backlog item to `child`, a running subagent this session started, so work that
 * belongs with what it already holds goes to it instead of a new child. The item is checked as for a delegation (not an
 * epic, not finished, not held by another session, no open prerequisite) and claimed for this session when unheld; an
 * item another running or reachable child serves is refused. The child may then update it besides its start item, until
 * its run ends. The summary names the child's context fill (with a warning at `CONTEXT_WARN_SHARE`) and the paths the
 * item shares with the child's own item.
 */
export function handItem(
	runs: HandRuns,
	lingering: Pick<Lingering, "onItem">,
	child: string,
	ref: string,
	ctx: Parameters<typeof openBacklog>[0],
): Handoff {
	if (!runs.running.has(child))
		throw new Error(
			`${child} is not a running subagent you started: item hands work only to such a child. Start one for it with agent task and item.`,
		);
	const handed = runs.handed;
	if (!handed) throw new Error("This session cannot hand items to its children.");
	const backlog: Backlog = openBacklog(ctx, { isSubagent: false });
	const { item, claimable } = checkDelegable(backlog, ref);
	if (runs.items.get(child) === item.ref || handed.has(child, item.ref))
		throw new Error(`${item.ref} is already ${child}'s item. Nothing was sent.`);
	refuseSecondChild(runs, lingering, item, [child]);
	const held = claimable ? claimDelegated(backlog, item) : item;
	backlog.store.hand(held, child, backlog.session);
	handed.add(child, held.ref, () => backlog.store.unhand(child, held));
	const start = runs.items.get(child);
	const shared = sharedPaths(held, start ? backlog.store.get(start) : undefined);
	const context = contextOf(runs, child);
	const near = context?.window !== undefined && context.used >= context.window * CONTEXT_WARN_SHARE;
	const parts = [
		`${claimable ? "Claimed" : "Handed"} ${held.ref} for ${child}: it may update it until its run ends.`,
		context
			? `Its ${contextText(context)}${near ? ": near full, so it may compact or run out; a fresh child may do better" : ""}.`
			: "Its context is not known yet (no model reply).",
		start
			? shared.length
				? `Shares ${shared.join(", ")} with its item ${start}.`
				: `Shares no paths with its item ${start}.`
			: "",
	];
	return {
		notice: renderPrompt("notices/subagents/item-handed.md", { ref: held.ref, title: held.title, goal: held.goal }),
		summary: parts.filter(Boolean).join(" "),
		undo: () => handed.end(child, held.ref),
	};
}
