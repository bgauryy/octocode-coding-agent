import type { FeatureContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import type { Team } from "../team/session.ts";
import { dirtyAmong } from "../worktrees/merge.ts";
import { noteMerge } from "./ref-link.ts";
import { repoRoot } from "./worktree-base.ts";
import { discardAgent, mergeAgent, reservedChanges, savedChanges } from "./worktree.ts";
import { changesInTree } from "./worktree-merge.ts";

/** Other agents working now in this team's checkouts: a merge changes files under them, so the ask names them. */
function livePeers(team: Pick<Team, "members">, id: string): string[] {
	return team
		.members()
		.filter((member) => member.id !== id && member.status === "working")
		.map((member) => member.id);
}

export interface MergeResult {
	ok: boolean;
	text: string;
	/** Refused because another agent holds a file the ref changes. */
	reserved?: boolean;
}

/** Why `id`'s result is not ready to merge: the child is still working (its ref may change yet); undefined when it is not. */
function stillWorking(team: Pick<Team, "members">, id: string): string | undefined {
	return team.members().some((member) => member.id === id && member.status === "working")
		? `Not merged: ${id} is still working, so its saved result may change. Wait for its report, then merge again.`
		: undefined;
}

/** Why the saved ref of `id` may not land now: the main checkout has uncommitted changes to files the ref changes. */
async function dirtyRefusal(cwd: string, id: string): Promise<string | undefined> {
	const saved = await savedChanges(cwd, id);
	const dirty = saved ? await dirtyAmong(repoRoot(cwd), saved.files) : [];
	if (dirty.length === 0) return undefined;
	const listed = `${dirty.slice(0, 10).join("\n")}${dirty.length > 10 ? `\n(${dirty.length - 10} more)` : ""}`;
	return `Not merged: this checkout has uncommitted changes to files ${saved?.ref} changes. Commit or stash them (or ask whoever holds them to), then merge again; ${saved?.ref} is kept and nothing changed.\n${listed}`;
}

/** When every change of `id`'s saved ref is already in the tree (applied by hand), the merge only drops the ref and notes it. */
async function landedByHand(
	id: string,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
): Promise<MergeResult | undefined> {
	const saved = await savedChanges(ctx.cwd, id);
	if (!saved || !(await changesInTree(ctx.cwd, id))) return undefined;
	const result = await discardAgent(ctx.cwd, id);
	if (!result.ok) return result;
	return {
		ok: true,
		text: `${saved.ref} is already in this tree: nothing to merge, the ref is removed.${noteMerge(ctx, saved.ref, "this tree")}`,
	};
}

/**
 * The one way an isolated child's saved ref lands: `/agents merge` and `coordinate merge` both come here, so neither can
 * skip the readiness checks (the child has finished, no file it changes is reserved), leave the ref behind or leave the
 * backlog note saying "not merged yet". `override` is asked when another agent holds a file the ref changes.
 */
export async function landChild(
	team: Pick<Team, "reservation" | "members">,
	id: string,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
	override: (listed: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: working };
	const byHand = await landedByHand(id, ctx);
	if (byHand) return byHand;
	const dirty = await dirtyRefusal(ctx.cwd, id);
	if (dirty) return { ok: false, text: dirty };
	const held = await reservedChanges(ctx.cwd, id, (file, shown) => team.reservation(file, shown));
	if (held.length > 0) {
		const listed = `${held.slice(0, 5).join("\n")}${held.length > 5 ? `\n(${held.length - 5} more)` : ""}`;
		if (!(await override(listed)))
			return { ok: false, reserved: true, text: `Not merged: ${id} changes reserved files.\n${listed}` };
	}
	const result = await mergeAgent(ctx.cwd, id, signal);
	const noted = result.ok && result.ref ? noteMerge(ctx, result.ref, result.into ?? "HEAD") : "";
	return { ok: result.ok, text: `${result.text}${noted}` };
}

/**
 * `coordinate merge`, for a run with nobody to land its children's work. A merge writes the tree, so it follows the same
 * policy as other workspace writes, after the readiness check, so nobody is asked about a merge that cannot happen; a
 * reservation it cannot override refuses it.
 */
export async function mergeChild(
	team: Pick<Team, "reservation" | "members">,
	permission: Permission,
	id: string,
	ctx: FeatureContext,
	signal?: AbortSignal,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: working };
	const saved = await savedChanges(ctx.cwd, id);
	if (!saved) return landChild(team, id, ctx, () => Promise.resolve(false), signal);
	const byHand = await landedByHand(id, ctx);
	if (byHand) return byHand;
	const dirty = await dirtyRefusal(ctx.cwd, id);
	if (dirty) return { ok: false, text: dirty };
	const held = await reservedChanges(ctx.cwd, id, (file, shown) => team.reservation(file, shown));
	if (held.length > 0) {
		const listed = `${held.slice(0, 5).join("\n")}${held.length > 5 ? `\n(${held.length - 5} more)` : ""}`;
		return { ok: false, reserved: true, text: `Not merged: ${id} changes reserved files.\n${listed}` };
	}
	const shown = saved.files.slice(0, 10);
	const peers = livePeers(team, id);
	const more = saved.files.length > shown.length ? [`(${saved.files.length - shown.length} more)`] : [];
	const verdict = await permission.check(ctx, {
		action: "file.workspace",
		title: "Merge this isolated subagent into the tree?",
		what: [
			`merge ${saved.ref} (the saved work of ${id}) into this tree`,
			`changes ${saved.files.length} file${saved.files.length === 1 ? "" : "s"}:`,
			...shown,
			...more,
			...(peers.length ? [`agents working now (tell those touching these files first): ${peers.join(", ")}`] : []),
		],
		cwd: ctx.cwd,
		...(signal ? { signal } : {}),
	});
	if (!verdict.allowed) return { ok: false, text: verdict.message };
	return landChild(team, id, ctx, () => Promise.resolve(false), signal);
}

/**
 * `coordinate discard`: the agent deletes its own child's saved ref, for work it replaced or abandoned. The work is lost,
 * so the user is asked first, as for any write to the workspace, with the ref and the files it changes.
 */
export async function discardByAgent(
	team: Pick<Team, "members">,
	permission: Permission,
	id: string,
	ctx: FeatureContext,
	signal?: AbortSignal,
): Promise<MergeResult> {
	return discardChild(team, id, ctx, async (ref, files) => {
		const shown = files.slice(0, 10);
		const verdict = await permission.check(ctx, {
			action: "file.workspace",
			title: "Discard this isolated subagent's unmerged work?",
			what: [
				`delete ${ref} (the saved work of ${id}) without merging it`,
				`it changes ${files.length} file${files.length === 1 ? "" : "s"}:`,
				...shown,
				...(files.length > shown.length ? [`(${files.length - shown.length} more)`] : []),
			],
			cwd: ctx.cwd,
			...(signal ? { signal } : {}),
		});
		return verdict.allowed;
	});
}

/**
 * `/agents discard`: deletes an isolated child's saved ref without merging it. The work is lost, so `confirm` is asked
 * first, naming the ref and the files it changes.
 */
export async function discardChild(
	team: Pick<Team, "members">,
	id: string,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
	confirm: (ref: string, files: string[]) => Promise<boolean>,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: `Not discarded: ${id} is still working, so its saved result may change.` };
	const saved = await savedChanges(ctx.cwd, id);
	if (!saved) return { ok: false, text: `No isolated changes for ${id} to discard.` };
	if (!(await confirm(saved.ref, saved.files))) return { ok: false, text: `Nothing discarded: ${saved.ref} is kept.` };
	const result = await discardAgent(ctx.cwd, id);
	return result.ok ? { ...result, text: `${result.text}${noteMerge(ctx, saved.ref)}` } : result;
}
