import { type JsonObject, validateToolArguments, type Tool } from "@octocodeai/octocode-ai";
import { rewriteClaudeBash } from "../../tool-input/claude-bash.ts";
import { shellTargetAccess } from "../file-access.ts";
import { isolatedTreeRefusal } from "../isolated-tree.ts";
import { readOnlyRoleRefusal } from "../read-only-role.ts";
import { commandWriteTargets } from "../shell/write-targets.ts";
import { captureToolInvocation } from "../../../core/tools/tool-invocation.ts";
import type { FeatureContext, ToolCallEvent } from "../../../core/features/index.ts";
import type { SourceDecision } from "../source-policy/rules.ts";
import type { Permission } from "../ask.ts";
import type { PrepareReplacement } from "../ask/types.ts";
import type { GateVerdict } from "../judge.ts";
import type { PermissionRequest } from "../request.ts";
import type { AllowedSource, CheckContext } from "../provenance/ignorable.ts";
import { credentialAsk, credentialHit } from "../credential-store.ts";
import { isGranted } from "../provenance/grant.ts";
import { classify } from "./classify.ts";

/** What validates and re-checks a command a user's answer replaced (`Permission.checkWithReplacement`). */
export interface ReplacementOwner {
	definition: (name: string) => Tool | undefined;
	refresh: (ctx: FeatureContext) => Promise<void>;
	reserved: (event: ToolCallEvent, ctx: FeatureContext) => Promise<GateVerdict | undefined>;
}

interface ReplacementDeps {
	owner: ReplacementOwner;
	permission: Permission;
	provenance: {
		check(
			event: ToolCallEvent,
			ctx: CheckContext,
			allowed?: AllowedSource,
		): { why: string; agent?: string } | undefined;
	};
	allowedSource: AllowedSource;
	env?: NodeJS.ProcessEnv;
	ctx: FeatureContext;
	originalEvent: ToolCallEvent;
	prior?: GateVerdict;
	/** False once the gate's call ended: a replacement made after that is cancelled. */
	active: () => boolean;
}

/**
 * The re-judgement of a `bash` call whose command the user's answer replaced: it re-checks the role, the reservation, the
 * class and provenance of the new command, and `commit` re-checks the reservation and source policy before the new input
 * replaces the call's own.
 */
export function prepareReplacement(deps: ReplacementDeps): PrepareReplacement {
	const { owner, permission, provenance, allowedSource, ctx, originalEvent, prior, active } = deps;
	return async (updated: JsonObject) => {
		if (!active() || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
		const definition = owner.definition(originalEvent.toolName);
		if (!definition) throw new Error("Cannot validate replacement for unknown tool");
		const replacement = rewriteClaudeBash(originalEvent.input, updated);
		const validated = validateToolArguments(definition, {
			type: "toolCall",
			id: originalEvent.toolCallId,
			name: originalEvent.toolName,
			arguments: replacement as JsonObject,
		});
		const candidate: ToolCallEvent = {
			...originalEvent,
			input: validated,
		};
		await owner.refresh(ctx);
		if (!active() || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
		const reservation = await owner.reserved(candidate, ctx);
		if (reservation?.block) throw new Error(reservation.reason ?? "Replacement target is reserved");
		const roleRefused =
			readOnlyRoleRefusal(candidate, ctx.cwd, deps.env) ?? isolatedTreeRefusal(candidate, ctx.cwd, deps.env);
		if (roleRefused) throw new Error(roleRefused);
		const classified = classify(candidate, ctx, false);
		if (!classified) throw new Error("Cannot classify Bash replacement");
		const candidateHit = provenance.check(candidate, ctx, allowedSource);
		const nextInvocation = captureToolInvocation(candidate.toolCallId, candidate.toolName, validated, active);
		if (!nextInvocation) throw new Error("Cannot capture replacement invocation");
		const credential = credentialAsk(credentialHit(candidate.toolName, validated, ctx.cwd), (grant) =>
			isGranted(permission, grant),
		);
		const request: PermissionRequest = {
			...classified,
			invocation: nextInvocation,
			signal: ctx.signal,
			...(candidateHit || prior?.ask || credential
				? {
						reasons: [
							...(candidateHit ? ["provenance" as const] : []),
							...(prior?.ask ? ["hook.ask" as const] : []),
							...(credential?.reasons ?? []),
						],
						reason: [candidateHit?.why, prior?.ask, credential?.reason].filter(Boolean).join("\n"),
						...(!candidateHit && credential?.grant ? { sourceGrant: credential.grant } : {}),
					}
				: {}),
		};
		let committed = false;
		return {
			request,
			commit: async (signal: AbortSignal, approvedSource: SourceDecision | undefined) => {
				if (committed || !active() || signal.aborted || ctx.signal?.aborted)
					throw new Error("PermissionRequest replacement cancelled or already committed");
				await owner.refresh(ctx);
				const finalReservation = await owner.reserved(candidate, ctx);
				if (finalReservation?.block) throw new Error(finalReservation.reason ?? "Replacement target is reserved");
				const source = permission.sourceDecision(nextInvocation, ctx.cwd);
				if (
					source?.decision === "deny" ||
					source?.decision === "unsupported" ||
					(source?.decision === "ask" && approvedSource?.decision !== "ask")
				)
					throw new Error(source.message ?? "Replacement refused by current source policy");
				for (const target of [
					...(source?.shellTargets ?? []),
					...commandWriteTargets(nextInvocation, ctx.cwd, source?.shellTargets),
				]) {
					const access = shellTargetAccess(target, ctx.cwd);
					if (access.refusal) throw new Error(access.refusal);
				}
				if (!active() || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
				if (signal.aborted) throw new Error("PermissionRequest replacement cancelled");
				for (const key of Object.keys(originalEvent.input))
					delete (originalEvent.input as Record<string, unknown>)[key];
				Object.assign(originalEvent.input, validated);
				committed = true;
			},
		};
	};
}
