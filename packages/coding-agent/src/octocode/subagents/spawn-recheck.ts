import type { FeatureContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { type AgentProfile, spawnRequest } from "./profiles.ts";

/**
 * Whether a spawn allowed earlier still passes the policy of now, for a queued child about to start: undefined when it
 * does, else why not. It never asks and leaves no audit entry. A spawn the user or a hook answered itself stays allowed
 * when only the answer would be needed again; one the mode or a grant allowed does not outlive them.
 */
export async function spawnStillAllowed(
	permission: Permission,
	ctx: Pick<FeatureContext, "hasUI" | "ui" | "cwd">,
	profile: AgentProfile | undefined,
	task: string,
	defaultTools: readonly string[] | undefined,
	approvedVia: string | undefined,
): Promise<string | undefined> {
	const { request } = spawnRequest(permission, ctx, profile, task, defaultTools, {});
	const verdict = await permission.check(ctx, { ...request, early: { park: () => undefined } });
	if (verdict.allowed) return undefined;
	if (verdict.via === "deferred")
		return approvedVia === "user" || approvedVia === "hook"
			? undefined
			: "the permission policy no longer allows starting it without asking";
	return verdict.message;
}
