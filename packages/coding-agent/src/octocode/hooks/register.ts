import type { FileInputReplacement } from "../shared/claude-file.ts";
import type { SourcePermissionUpdate } from "../shared/permission-updates.ts";
import { registerBackgroundHooks } from "./background.ts";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { envFlag, SUBAGENT_ENV, SUBAGENT_HOOKS_ENV } from "../../../../common/src/env.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { commandsFor, hookCalls } from "./config/calls.ts";
import { emptyHooks } from "./config/parse.ts";
import type { HookVerdict } from "./contracts.ts";
import { CODEX_PATCH_NAMES, type EditProjector, projectCodexPatch } from "./patch.ts";
import type { HookProtocol } from "./catalog.ts";
import { createDispatcher } from "./register/dispatcher.ts";
import { decidingDenial } from "./verdicts.ts";
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
import { hookCount, hookEventsReport, hooksReport } from "./register/report.ts";
import { registerSessionStartHooks } from "./register/session-start.ts";
import { registerStopHook, registerStopRenderer } from "./register/stop.ts";
import { registerSubagentHooks } from "./register/subagent.ts";
import type { HookFailureSink, HookHostMetadata, HookSession, HookTiming, HooksView } from "./register/types.ts";

/**
 * Claude Code / Codex / Octocode command hooks, adapted from the native host's hook dispatcher:
 * PreToolUse → `tool_call` (can block), PostToolUse → `tool_result` (can add feedback), SessionStart (also after a
 * compaction, source `compact`) → context for the next prompt, PreCompact → `session_before_compact` (side effects
 * only), Stop → `agent_before_settle` (a block makes the agent continue with the reason), Notification → when Octocode asks
 * the user something or an answer waits (side effects only). Each source keeps its own profile: `.claude` files the
 * Claude rules, `.codex` files the Codex rules, Octocode files the native contract. Project files load only after
 * `/trust`, plugin hooks only with a reviewed fingerprint, and any loaded `disableAllHooks: true` turns them all off.
 * Octocode's PreMessageSend gates team/API/external sends; PostMessageReceive observes actual delivery without changing
 * the body or requesting a reply.
 */
/** Every main session runs hooks; a subagent only when its profile declares `hooks: true` (`SUBAGENT_HOOKS_ENV`). */
const hooksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
	!envFlag(env, SUBAGENT_ENV) || envFlag(env, SUBAGENT_HOOKS_ENV);

export function registerHooks(
	api: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	home?: string,
	onFailure?: HookFailureSink,
	metadata?: () => HookHostMetadata,
	paused?: () => boolean,
	/** The file tool's projection of edit queries for Codex apply_patch hooks; without it those edits are refused. */
	projectEdit?: EditProjector,
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
				: "off in this subagent (its profile does not set hooks: true)",
		report: (cwd) => hooksReport(enabled, session.config, session.errors, cwd, home, timings),
		preToolUse: async () => undefined,
		permissionRequest: async () => undefined,
		hasFilePermissionRequest: () => false,
		fileInputCommitted: () => {},
		notification: () => undefined,
		messageSend: async () => undefined,
		messageReceive: async () => undefined,
	};
	// Registered even when hooks are off: a resumed session may hold Stop feedback from an earlier run.
	registerStopRenderer(api);
	if (!enabled) return view;
	const background = registerBackgroundHooks(api);
	const child = envFlag(env, SUBAGENT_ENV);
	const runner = createDispatcher(api, session, timings, onFailure, background, child, metadata, paused);
	view.suspend = async () => {
		await Promise.all([runner.stop(), background.reset(false)]);
	};
	// The message handlers go first: their session_start reset runs before the hook files load.
	Object.assign(view, registerMessageHooks(api, runner));
	registerStopHook(api, session, runner.dispatch, child);
	registerSessionStartHooks(api, session, runner, home, child);
	if (child) registerSubagentHooks(api, session, runner.dispatch, env, metadata);
	const patches = new Map<string, string>();
	api.on("session_start", async () => {
		patches.clear();
	});
	api.on("session_shutdown", async () => {
		patches.clear();
	});
	api.on("turn_end", async () => {
		patches.clear();
	});
	view.hasFilePermissionRequest = (input, cwd) =>
		hookCalls("file", input, cwd).some((call) =>
			commandsFor(session.config, "PermissionRequest", call.names).some((hook) => hook.protocol === "claude"),
		) || commandsFor(session.config, "PermissionRequest", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
	view.fileInputCommitted = (id, input, cwd) => {
		patches.delete(id);
		try {
			patches.set(id, projectCodexPatch(input, projectEdit && cwd ? { projectEdit, cwd } : undefined));
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
				const results = await Promise.all(calls.map((call) => run(call, protocol)));
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
	view.preToolUse = preToolUseGate(api, runner.dispatch, session, patches, projectEdit);
	view.notification = notificationHook(api, runner);
	registerPostToolUseHook(api, runner.dispatch, session, patches);
	registerPreCompactHook(api, runner.dispatch);
	if (!child) registerInterruptHook(api, session, runner.dispatch, metadata);
	registerPromptHook(api, runner.dispatch);
	registerPostCompactHook(api, runner.dispatch);
	registerPostToolBatchHook(api, runner.dispatch);
	registerSessionEndHook(api, session, runner.dispatch, env);
	return view;
}
/** `/hooks`: what loaded, from where, and the events each profile supports. */
export function registerHooksCommand(commands: Subcommands, hooks: HooksView): void {
	commands.add("hooks", {
		description: "Inspect loaded hooks and supported events",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "events") return say(ctx, hookEventsReport());
			if (arg)
				return say(
					ctx,
					'Usage: /hooks [events] (inspection only). Switch hooks on or off with /plugins; "disableAllHooks": true in a hook file turns them all off.',
					"warning",
				);
			say(ctx, hooks.report(ctx.cwd));
		},
	});
}
