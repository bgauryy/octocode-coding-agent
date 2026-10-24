import type { FileInputReplacement } from "../shared/claude-file.ts";
import type { SourcePermissionUpdate } from "../shared/permission-updates.ts";
import { registerBackgroundHooks } from "./background.ts";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { envFlag, HOOKS_COMPAT_ENV, HOOKS_ENV, SUBAGENT_ENV } from "../shared/env.ts";
import { errorMessage, isRecord } from "../../utils/guards.ts";
import { commandsFor, hookCalls } from "./config/calls.ts";
import { emptyHooks } from "./config/parse.ts";
import type { HookVerdict } from "./contracts.ts";
import { CODEX_PATCH_NAMES, projectCodexPatch } from "./patch.ts";
import type { HookProtocol } from "./profiles.ts";
import { createDispatcher } from "./register/dispatcher.ts";
import {
	registerInterruptHook,
	registerPostCompactHook,
	registerPostToolBatchHook,
	registerPreCompactHook,
	registerPromptHook,
	registerSessionEndHook,
} from "./register/events.ts";
import { notificationHook, registerMessageHooks } from "./register/messages.ts";
import { registerPostToolUseHook } from "./register/post-tool-use.ts";
import { preToolUseGate } from "./register/pre-tool-use.ts";
import { hookCount, hooksReport } from "./register/report.ts";
import { registerSessionStartHooks } from "./register/session-start.ts";
import { registerStopHook, registerStopRenderer } from "./register/stop.ts";
import { registerSubagentHooks } from "./register/subagent.ts";
import type { HookFailureSink, HookHostMetadata, HookSession, HookTiming, HooksView } from "./register/types.ts";

/**
 * Optional adapter for Claude Code / Codex command hooks, adapted from the native host's hook dispatcher:
 * PreToolUse → `tool_call` (can block), PostToolUse → `tool_result` (can add feedback), SessionStart (also after a
 * compaction, source `compact`) → context for the next prompt, PreCompact → `session_before_compact` (side effects
 * only), Stop → `agent_before_settle` (a block makes the agent continue with the reason), Notification → when Octocode asks
 * the user something or an answer waits (side effects only). Off unless `OCTOCODE_HOOKS=1`, because hooks written for
 * another agent run arbitrary commands. Octocode's PreMessageSend gates team/API/external sends; PostMessageReceive
 * observes actual delivery without changing the body or requesting a reply.
 */
const hooksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => envFlag(env, HOOKS_ENV);

export function registerHooks(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	home?: string,
	onFailure?: HookFailureSink,
	metadata?: () => HookHostMetadata,
	paused?: () => boolean,
): HooksView {
	const session: HookSession = { config: emptyHooks(), errors: [], root: undefined };
	const enabled = hooksEnabled(env);
	const timings = new Map<string, HookTiming>();
	const view: HooksView = {
		summary: () =>
			enabled
				? paused?.()
					? "paused during planning"
					: `on, ${hookCount(session.config)} commands`
				: `off (${HOOKS_ENV}=1 to enable)`,
		report: (cwd) =>
			hooksReport(enabled, session.config, session.errors, cwd, home, timings, envFlag(env, HOOKS_COMPAT_ENV)),
		preToolUse: async () => undefined,
		permissionRequest: async () => undefined,
		hasFilePermissionRequest: () => false,
		fileInputCommitted: () => {},
		notification: () => undefined,
		messageSend: async () => undefined,
		messageReceive: async () => undefined,
	};
	// Registered even when hooks are off: a resumed session may hold Stop feedback from an earlier run.
	registerStopRenderer(pi);
	if (!enabled) return view;
	const background = envFlag(env, HOOKS_COMPAT_ENV) ? registerBackgroundHooks(pi) : undefined;
	const child = envFlag(env, SUBAGENT_ENV) && envFlag(env, HOOKS_COMPAT_ENV);
	const runner = createDispatcher(pi, session, timings, onFailure, background, child, metadata, paused);
	view.suspend = async () => {
		await Promise.all([runner.stop(), background?.reset(false)]);
	};
	// The message handlers go first: their session_start reset runs before the hook files load.
	Object.assign(view, registerMessageHooks(pi, runner));
	registerStopHook(pi, session, runner.dispatch, child);
	registerSessionStartHooks(pi, session, runner, home, envFlag(env, HOOKS_COMPAT_ENV), child);
	if (child) registerSubagentHooks(pi, session, runner.dispatch, env, metadata);
	const patches = new Map<string, string>();
	pi.on("session_start", async () => {
		patches.clear();
	});
	pi.on("session_shutdown", async () => {
		patches.clear();
	});
	pi.on("turn_end", async () => {
		patches.clear();
	});
	view.hasFilePermissionRequest = (input, cwd) =>
		hookCalls("file", input, cwd).some((call) =>
			commandsFor(session.config, "PermissionRequest", call.names).some((hook) => hook.protocol === "claude"),
		) || commandsFor(session.config, "PermissionRequest", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
	view.fileInputCommitted = (id, input) => {
		patches.delete(id);
		try {
			patches.set(id, projectCodexPatch(input));
		} catch {
			/* Unsupported projections are diagnosed by the existing post-hook owner. */
		}
	};

	view.permissionRequest = async (invocation, ctx, signal) => {
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
		const run = (call: { names: string[]; tool_name: string; tool_input: unknown }, protocol: HookProtocol) =>
			runner.dispatch(
				ctx,
				"PermissionRequest",
				call.names,
				() => ({
					tool_name: call.tool_name,
					tool_input: call.tool_input,
					pi_tool_name: invocation.toolName,
				}),
				signal,
				protocol,
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
								tool_input: { command: projectCodexPatch(input) },
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
				const results = await Promise.all(calls.map((call) => run(call, protocol)));
				const deny =
					results.find((verdict) => verdict.permissionDecision === "deny" && verdict.permissionInterrupt) ??
					results.find((verdict) => verdict.permissionDecision === "deny");
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
		const deny =
			verdicts.find((verdict) => verdict.permissionDecision === "deny" && verdict.permissionInterrupt) ??
			verdicts.find((verdict) => verdict.permissionDecision === "deny");
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
	view.preToolUse = preToolUseGate(pi, runner.dispatch, session, patches);
	view.notification = notificationHook(pi, runner);
	registerPostToolUseHook(pi, runner.dispatch, session, patches);
	registerPreCompactHook(pi, runner.dispatch);
	if (envFlag(env, HOOKS_COMPAT_ENV)) {
		if (!envFlag(env, SUBAGENT_ENV)) registerInterruptHook(pi, session, runner.dispatch, metadata);
		registerPromptHook(pi, runner.dispatch);
		registerPostCompactHook(pi, runner.dispatch);
		registerPostToolBatchHook(pi, runner.dispatch);
		registerSessionEndHook(pi, session, runner.dispatch, env);
	}
	return view;
}
/** `/hooks`: whether hooks run, what loaded, and which files to edit. */
export function registerHooksCommand(commands: Subcommands, hooks: HooksView): void {
	commands.add("hooks", {
		description: "hooks — inspect enablement, loaded commands, sources and diagnostics",
		handler: async (args, ctx) => {
			if (args.trim())
				return say(
					ctx,
					"Usage: /hooks (inspection only). Start Octocode with OCTOCODE_HOOKS=1 to enable hooks, or OCTOCODE_HOOKS=0 to disable them.",
					"warning",
				);
			say(ctx, hooks.report(ctx.cwd));
		},
	});
}
