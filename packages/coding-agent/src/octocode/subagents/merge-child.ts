import type { ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import type { Team } from "../team/session.ts";
import { noteMerge } from "./ref-link.ts";
import { discardAgent, mergeAgent, reservedChanges, savedChanges } from "./worktree.ts";

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

/**
 * The one way an isolated child's saved ref lands: `/agents merge` and `coordinate merge` both come here, so neither can
 * skip the readiness checks (the child has finished, no file it changes is reserved), leave the ref behind or leave the
 * backlog note saying "not merged yet". `override` is asked when another agent holds a file the ref changes.
 */
export async function landChild(
	team: Pick<Team, "reservation" | "members">,
	id: string,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	override: (listed: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: working };
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
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: working };
	const saved = await savedChanges(ctx.cwd, id);
	const shown = saved?.files.slice(0, 10) ?? [];
	const more = saved && saved.files.length > shown.length ? [`(${saved.files.length - shown.length} more)`] : [];
	const verdict = await permission.check(ctx, {
		action: "file.workspace",
		title: "Merge this isolated subagent into the tree?",
		what: [
			saved
				? `merge ${saved.ref} (the saved work of ${id}) into this tree`
				: `merge the saved work of ${id} into this tree`,
			...(saved
				? [`changes ${saved.files.length} file${saved.files.length === 1 ? "" : "s"}:`, ...shown, ...more]
				: []),
		],
		cwd: ctx.cwd,
		...(signal ? { signal } : {}),
	});
	if (!verdict.allowed) return { ok: false, text: verdict.message };
	return landChild(team, id, ctx, () => Promise.resolve(false), signal);
}

/**
 * `/agents discard`: deletes an isolated child's saved ref without merging it. The work is lost, so `confirm` is asked
 * first, naming the ref and the files it changes.
 */
export async function discardChild(
	team: Pick<Team, "members">,
	id: string,
	ctx: Pick<ExtensionContext, "cwd">,
	confirm: (ref: string, files: string[]) => Promise<boolean>,
): Promise<MergeResult> {
	const working = stillWorking(team, id);
	if (working) return { ok: false, text: `Not discarded: ${id} is still working, so its saved result may change.` };
	const saved = await savedChanges(ctx.cwd, id);
	if (!saved) return { ok: false, text: `No isolated changes for ${id} to discard.` };
	if (!(await confirm(saved.ref, saved.files))) return { ok: false, text: `Nothing discarded: ${saved.ref} is kept.` };
	return discardAgent(ctx.cwd, id);
}
