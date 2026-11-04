import type { ExtensionContext, ToolCallEvent } from "../../core/features/index.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { shellPath } from "./file-access.ts";
import { callRequest } from "./gate/classify.ts";
import type { PermissionRequest } from "./request.ts";
import { gitLandings, type SwitchedBranch } from "./shell/git-landing.ts";

/** The branch a landing would reach: the repository's default branch, checked out in its main checkout. */
interface ProtectedBranch {
	branch: string;
	checkout: string;
}

/**
 * Whether a git call in `dir` acts on the main checkout while it is on the default branch; undefined when it does not or
 * git cannot say. `switchedTo` is the branch the same line moved it to. `worktrees/default-branch.ts` is the real one.
 */
export type FindProtectedBranch = (dir: string, switchedTo?: SwitchedBranch) => Promise<ProtectedBranch | undefined>;

/** The first landing of `command` that reaches a protected branch. Anything that cannot be read or determined is no landing: the session's normal rules apply. */
async function protectedLanding(
	command: string,
	cwd: string,
	find: FindProtectedBranch,
): Promise<ProtectedBranch | undefined> {
	try {
		for (const landing of gitLandings(command))
			for (const dir of landing.dirs) {
				const found = await find(dir === "" ? cwd : shellPath(cwd, dir), landing.switchedTo);
				if (found) return found;
			}
	} catch {
		// Fail open: a guard that cannot tell leaves the call to the mode table.
	}
	return undefined;
}

/**
 * The request for a `bash` call: `classified` unchanged, unless the command lands commits on the protected branch, which
 * is the `worktree.merge` ask in every mode, with the session answer the merge tool's dialog has. A destructive command
 * stays that class, so its restore point is still taken, and needs the merge class too. A session grant answers the
 * landing, so what else the command is still follows its own class (`manual` still reviews it) and the audit records both.
 */
export async function landingRequest(
	event: ToolCallEvent,
	ctx: Pick<ExtensionContext, "cwd">,
	classified: PermissionRequest | undefined,
	find: FindProtectedBranch,
	granted: boolean,
): Promise<PermissionRequest | undefined> {
	const input = event.input as Record<string, unknown>;
	if (event.toolName !== "bash" || input.type === "powershell" || typeof input.command !== "string") return classified;
	const found = await protectedLanding(input.command, ctx.cwd, find);
	if (!found) return classified;
	const { branch, checkout } = found;
	const target = `on ${branch} in the main checkout ${checkout}`;
	const named = {
		reason: renderInstruction("notices/landing/why.md", { branch, checkout }),
		nextStep: renderInstruction("notices/landing/next-step.md"),
	};
	if (classified?.action === "shell.destructive")
		return {
			...classified,
			also: [...(classified.also ?? []), "worktree.merge"],
			what: [classified.what[0] ?? input.command, target, ...classified.what.slice(1)],
			...named,
		};
	return callRequest(
		{
			action: "worktree.merge",
			...(granted && classified?.action ? { also: [classified.action] } : {}),
			title: `Land commits on ${branch} in the main checkout?`,
			what: [input.command, target, `cwd: ${ctx.cwd}`],
			effect: `lands commits on ${branch}, the default branch, in ${checkout}`,
			...named,
		},
		event,
		ctx,
	);
}
