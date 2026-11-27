import type { FileInputReplacement } from "../../tool-input/claude-file.ts";
import type { SourcePermissionUpdate } from "../../shared/permission-updates.ts";
import { parsePatch } from "../../tool-input/codex-patch/patch.ts";
import { say } from "../../shared/commands.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { commandsFor, hookCalls, hookIdentity } from "../config/calls.ts";
import { ifFilter } from "../config/if-filter.ts";
import type { HookVerdict } from "../contracts.ts";
import { CODEX_PATCH_NAMES, type EditProjector, projectCodexPatch } from "../patch.ts";
import type { HookProtocol } from "../catalog.ts";
import { decidingDenial, reducePermission } from "../verdicts.ts";
import { interpretPromptHook } from "../prompt.ts";
import { clipText, stringOrEmpty } from "../../shared/util.ts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { type EventPolicy, warnFailure } from "./event-policy.ts";
import type { Dispatch, HookFailureSink, HookSession, HooksView } from "./types.ts";

const failsClosed = (hook: { failClosed?: boolean; onFailure?: string }): boolean =>
	hook.failClosed === true || hook.onFailure === "block";

/**
 * How a PermissionRequest hook's run is read. All Claude hooks finish (a deny beats an allow, as for Codex) and a
 * crash is a hook's own verdict. A hook that fails, or whose configuration is invalid, denies when it is `failClosed`.
 * A prompt answer never decides the approval (docs/hooks.md): a malformed one is a hook failure, and the reason of an
 * `ok: false` is shown, once per hook and reason, instead of being dropped.
 */
export const permissionRequestPolicy: EventPolicy = {
	guarded: (protocol) => protocol === "claude",
	crash(env, message) {
		say(env.ctx, message, "warning");
		return failsClosed(env.hook) ? { permissionDecision: "deny", block: message } : { error: message };
	},
	configurationError(env, message) {
		say(env.ctx, message, "warning");
		env.onFailure?.(["PermissionRequest"], message, false);
		return { permissionDecision: "deny", block: message };
	},
	prompt(env, run) {
		const observed = interpretPromptHook(env.event, run);
		if (observed.error) return { error: observed.error };
		if (observed.block) {
			const reason = clipText(redactSecrets(observed.block), 200);
			if (env.firstTime(`observed\0${hookIdentity(env.hook)}\0${reason}`))
				say(env.ctx, `PermissionRequest prompt hook (observational): ${reason}`, "warning");
		}
		return {};
	},
	settle(env, verdict, failure) {
		if (!failure) return verdict;
		warnFailure(env, failure);
		env.onFailure?.([`PermissionRequest ${stringOrEmpty(env.payload.tool_name)}`], failure, false);
		return failsClosed(env.hook) ? { permissionDecision: "deny", block: failure } : verdict;
	},
	decide(verdicts, signal) {
		if (signal?.aborted) return {};
		const reduced = reducePermission(verdicts);
		// An allow keeps what its hook attached (rewritten input, permission updates).
		return reduced.permissionDecision === "allow"
			? (verdicts.find((verdict) => verdict.permissionDecision === "allow") ?? reduced)
			: reduced;
	},
};

/**
 * The PermissionRequest hooks' answer to an approval about to be asked: a denial from any hook denies, else an allow
 * from every hook of a profile allows, with the input or permission updates it attached. `decisionsOnly` (a subagent in
 * the `decisions` hook mode): only a denial is returned, so a hook's allow grants nothing there and the approval goes on
 * to the subagent's usual path (its parent, or a refusal).
 */
export function permissionRequestHook(
	session: HookSession,
	dispatch: Dispatch,
	onFailure: HookFailureSink | undefined,
	projectEdit: EditProjector | undefined,
	decisionsOnly = false,
): HooksView["permissionRequest"] {
	const answer: HooksView["permissionRequest"] = async (invocation, ctx, signal) => {
		if (!isRecord(invocation.input)) return undefined;
		const input = invocation.input;
		if (
			invocation.toolName === "file" &&
			typeof input.patch === "string" &&
			parsePatch(input.patch).hunks.some((hunk) => hunk.kind === "update") &&
			commandsFor(session.config, "PermissionRequest", ["file", "Edit", "MultiEdit", "Write", "Delete"]).some(
				(hook) => hook.protocol === "claude",
			)
		) {
			const message =
				"Canonical Update/Move patches cannot be represented losslessly to matching Claude PermissionRequest hooks";
			say(ctx, message, "warning");
			onFailure?.([invocation.toolName], message, false);
			return { decision: "deny", message };
		}
		const calls = hookCalls(invocation.toolName, input, ctx.cwd);
		const run = (
			call: { names: string[]; tool_name: string; tool_input: unknown },
			protocol: HookProtocol,
			index?: number,
		) =>
			dispatch(
				ctx,
				"PermissionRequest",
				call.names,
				() => ({
					tool_name: call.tool_name,
					tool_input: call.tool_input,
					octocode_tool_name: invocation.toolName,
				}),
				signal,
				protocol,
				// A Claude handler's `if` rule; a `file` call is judged per query.
				ifFilter(invocation.toolName, input, ctx.cwd, invocation.toolName === "file" ? index : undefined),
			);
		const verdicts: HookVerdict[] = [];
		const fileReplacements: FileInputReplacement[] = [];
		const permissionUpdates: SourcePermissionUpdate[] = [];
		for (const protocol of ["claude", "codex"] as const) {
			if (protocol === "codex" && invocation.toolName === "file") {
				if (
					!commandsFor(session.config, "PermissionRequest", CODEX_PATCH_NAMES).some(
						(hook) => hook.protocol === protocol,
					)
				)
					continue;
				try {
					verdicts.push(
						await run(
							{
								names: CODEX_PATCH_NAMES,
								tool_name: "apply_patch",
								tool_input: {
									command: projectCodexPatch(input, projectEdit ? { projectEdit, cwd: ctx.cwd } : undefined),
								},
							},
							protocol,
						),
					);
				} catch (error) {
					const message = `PermissionRequest projection unavailable: ${errorMessage(error)}`;
					say(ctx, message, "warning");
					onFailure?.([invocation.toolName], message, false);
					verdicts.push({ permissionDecision: "deny", block: message });
				}
			} else {
				const results = await Promise.all(calls.map((call, index) => run(call, protocol, index)));
				const deny = decidingDenial(results);
				if (deny) verdicts.push(deny);
				else if (results.length && results.every((verdict) => verdict.permissionDecision === "allow")) {
					permissionUpdates.push(...results.flatMap((verdict) => verdict.updatedPermissions ?? []));
					if (invocation.toolName === "file" && Array.isArray(input.queries)) {
						results.forEach((verdict, index) => {
							if (verdict.updatedInput !== undefined) fileReplacements.push({ index, input: verdict.updatedInput });
						});
						verdicts.push({ permissionDecision: "allow" });
					} else
						verdicts.push(
							results.find((verdict) => verdict.updatedInput !== undefined) ?? { permissionDecision: "allow" },
						);
				}
			}
		}
		const deny = decidingDenial(verdicts);
		if (deny)
			return {
				decision: "deny",
				message: deny.block,
				interrupt: deny.permissionInterrupt,
			};
		const replacement = verdicts.find((verdict) => verdict.updatedInput !== undefined)?.updatedInput;
		if (replacement !== undefined && invocation.toolName !== "bash")
			return {
				decision: "deny",
				message:
					"PermissionRequest input replacement requires a supported Bash or file-query transaction; call not executed",
			};
		return verdicts.some((verdict) => verdict.permissionDecision === "allow")
			? {
					decision: "allow",
					...(replacement !== undefined ? { updatedInput: replacement } : {}),
					...(fileReplacements.length ? { updatedFileInputs: fileReplacements } : {}),
					...(permissionUpdates.length ? { updatedPermissions: permissionUpdates } : {}),
				}
			: undefined;
	};
	if (!decisionsOnly) return answer;
	return async (invocation, ctx, signal) => {
		const decided = await answer(invocation, ctx, signal);
		return decided?.decision === "deny" ? { decision: "deny", message: decided.message } : undefined;
	};
}
