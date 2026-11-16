import type { Settings } from "../../core/settings-schema.ts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { textResult } from "../shared/util.ts";
import type { AgentRuns, Run } from "./claim.ts";
import type { RunDetails } from "./run-types.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { routeSummary } from "./model.ts";
import { openBacklog } from "../backlog/context.ts";
import { startedNotice } from "../backlog/graph-notice.ts";
import { type AfterHost, openPrerequisites } from "./chain.ts";
import { type ItemLink, itemLink } from "./item-link.ts";
import { handoffLines, queueChild } from "./queued-start.ts";
import { type Prerequisite, prerequisiteName } from "./prerequisites.ts";
import { taskReferences } from "./task-text.ts";

/**
 * The item a call names and what it must wait for. A background call may wait (`subagents.queuedStarts`): its `after`
 * list and the open `dependsOn` of its item, left unclaimed until it starts. Any other call is refused for an item
 * that waits on an open one, as before, and refused for an `after` it cannot honour.
 */
export function chainPlan(
	runs: Pick<AgentRuns, "chain" | "running" | "background">,
	settings: Pick<Settings, "subagents">,
	params: { item?: string | undefined; after?: string[] | undefined; background?: boolean | undefined },
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	resuming: boolean,
): { linked: ItemLink | undefined; after: Prerequisite[] } {
	const queuing =
		params.background === true && settings.subagents?.queuedStarts !== false && !resuming && runs.chain !== undefined;
	if (params.after?.length && !queuing)
		throw new Error(
			"after queues a background child: it needs background: true, no resume, and the setting subagents.queuedStarts.",
		);
	const linked = itemLink(ctx, params.item, { queue: queuing, queued: () => runs.chain?.items() ?? new Set() });
	// A call with no item and no `after` has nothing to wait for: the board is not opened for it.
	if (!queuing || !runs.chain || (!linked && !params.after?.length)) return { linked, after: [] };
	const backlog = openBacklog(ctx, { isSubagent: false });
	const host: AfterHost = {
		item: (ref) => {
			const item = backlog.store.get(ref);
			if (!item) return { standing: "missing", dependsOn: [] };
			const standing = item.state !== "done" ? "open" : item.closed ? "closed" : "done";
			return { standing, dependsOn: standing === "open" ? backlog.store.openPrerequisites(item) : [] };
		},
		liveChild: (id) => runs.running.has(id) || runs.background.has(id),
	};
	return { linked, after: openPrerequisites(host, runs.chain, params.after ?? [], linked?.ref, linked?.waitsOn ?? []) };
}

/** The `Referenced content` a started child gets for the prerequisites it waited for; a report that cannot be read is left out. */
async function chainHandoff(
	runs: Pick<AgentRuns, "team">,
	after: readonly Prerequisite[],
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	artifactAccess: "local" | "none",
): Promise<string> {
	const { reports, text } = handoffLines(after, openBacklog(ctx, { isSubagent: false }));
	let block = "";
	for (const report of reports) {
		try {
			block = [block, await taskReferences(report, runs.team, ctx, artifactAccess)].filter(Boolean).join("\n\n");
		} catch {
			// The prerequisite ended without a readable report: the child starts without it.
		}
	}
	return [block, text].filter(Boolean).join("\n\n");
}

/** What the call's result says about a child it queued. */
function queuedChainText(
	id: string,
	role: string,
	after: readonly Prerequisite[],
	working: (name: string) => string | undefined,
): string {
	const names = after.map((each) => {
		const name = prerequisiteName(each);
		const by = working(name);
		return by ? `${name} (${by} works on it)` : name;
	});
	return `Queued ${id} (${role}): starts when ${names.join(", ")} ${names.length > 1 ? "are" : "is"} done; it holds no slot, paths or item until then. Its report arrives as a message; cancel with \`coordinate\` \`stop\` ${id}.`;
}

/** A queued run: it waits for its prerequisites, takes what they left, and tells the coordinator when it starts. */
export interface QueuedRun {
	/** Resolves when it may start (`queueChild`); the note for its report, and the content its prerequisites hand it. */
	start(
		signal: AbortSignal,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
		access: "local" | "none",
	): Promise<{ note: string; referenced: string }>;
	/** It started: the coordinator is told (`item-started.md`). */
	started(): void;
	/** It left the queue. */
	finish(): void;
}

/** Puts the claimed `run` in the queue behind `after`; `prepare` is what its start does once they ended well. */
export function queueRun(
	runs: Pick<AgentRuns, "chain" | "graph" | "team">,
	run: Run,
	{
		goal,
		item,
		after,
		details,
	}: { goal: string; item: string | undefined; after: readonly Prerequisite[]; details: RunDetails },
	/** Why the permission policy of the moment no longer allows the start; undefined when it does (`spawnStillAllowed`). */
	refusal: () => Promise<string | undefined>,
	prepare: () => void,
): QueuedRun {
	const tell = (notice: string) => runs.graph?.tell(notice);
	const names = after.map(prerequisiteName);
	const queued = queueChild(runs.chain!, tell, {
		id: run.identity.id,
		role: run.identity.role,
		goal,
		item,
		after: [...after],
		prepare: async () => {
			const why = await refusal();
			if (why) throw new Error(why);
			prepare();
		},
		onHeld: (why) => {
			if (why === undefined) delete details.held;
			else details.held = why;
		},
	});
	return {
		async start(signal, ctx, access) {
			await queued.wait(signal);
			return {
				note: `\n\nStarted after ${names.join(", ")}.`,
				referenced: await chainHandoff(runs, after, ctx, access),
			};
		},
		started: () => {
			runs.chain?.markStarted(run.identity.id);
			details.startedAfter = names;
			tell(startedNotice(run.identity.id, item, names));
		},
		finish: queued.finish,
	};
}

/** The call's result for a child it queued: its row shows what it waits for. */
export function queuedResult(
	runs: Pick<AgentRuns, "items">,
	run: Run,
	after: readonly Prerequisite[],
	details: RunDetails,
	notes: string,
): AgentToolResult<RunDetails> {
	details.after = after.map(prerequisiteName);
	const working = (name: string) => [...runs.items].find(([, ref]) => ref === name)?.[0];
	return textResult(`${queuedChainText(run.identity.id, run.identity.role, after, working)}${notes}`, details);
}

/** A queued or held child `id` starts now; the call's result, or undefined when `id` is no queued child. */
export function startHeld(runs: Pick<AgentRuns, "chain">, id: string): AgentToolResult<RunDetails> | undefined {
	if (!runs.chain?.get(id)) return undefined;
	const refused = runs.chain.start(id);
	if (refused) throw new Error(refused);
	return textResult(`Starting queued ${id} now; its report arrives as a message.`);
}

/** The result of a background call that queued for a slot or for the paths of a running child (not for prerequisites). */
export function queuedText(
	runs: Pick<AgentRuns, "running">,
	run: Pick<Run, "identity" | "route">,
	waitsForSiblings: boolean,
	notes: string,
): string {
	const wait = waitsForSiblings
		? "it holds no paths yet: it waits for the children holding them, then for a slot"
		: `${runs.running.size - 1} subagents are ahead of it or running, and it starts when a slot frees`;
	return `Queued ${run.identity.id} (${run.identity.role}) in the background: ${wait}. Its report arrives as a message. Runs on ${routeSummary(run.route)}.${notes}`;
}
