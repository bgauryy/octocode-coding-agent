import { registerBackgroundHooks } from "./background.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { envFlag, PARENT_SESSION_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { sessionHookMode } from "../shared/hook-mode.ts";
import { commandsFor, hookCalls } from "./config/calls.ts";
import { ifFilter } from "./config/if-filter.ts";
import { emptyHooks } from "./config/parse.ts";
import { CODEX_PATCH_NAMES, type EditProjector, projectCodexPatch } from "./patch.ts";
import { createDispatcher } from "./register/dispatcher.ts";
import {
	registerInterruptHook,
	registerPostCompactHook,
	registerPostToolBatchHook,
	registerPreCompactHook,
	registerPromptHook,
	registerSessionEndHook,
} from "./register/events.ts";
import { registerAgentHooks } from "./register/agents.ts";
import { notificationHook, registerMessageHooks } from "./register/messages.ts";
import { registerPostToolUseHook } from "./register/post-tool-use.ts";
import { permissionRequestHook } from "./register/permission-request.ts";
import { preToolUseGate } from "./register/pre-tool-use.ts";
import { plural } from "../shared/text.ts";
import { hooksPromptSection } from "./prompt-section.ts";
import { CHILD_MODE_NOTE, hookCount, hooksReport } from "./register/report.ts";
import { loadSessionHooks, registerSessionStartHooks } from "./register/session-start.ts";
import { registerStopHook, registerStopRenderer } from "./register/stop.ts";
import { testRunHooks } from "./register/test-run.ts";
import { registerSubagentHooks } from "./register/subagent.ts";
import type { HookFailureSink, HookHostMetadata, HookSession, HookTiming, HooksView } from "./register/types.ts";

/**
 * Claude Code / Codex / Octocode command hooks, adapted from the native host's hook dispatcher:
 * PreToolUse → `tool_call` (can block), PostToolUse → `tool_result` (can add feedback), SessionStart (also after a
 * compaction, source `compact`) → context for the next prompt, PreCompact → `session_before_compact` (side effects
 * only), Stop → `agent_before_settle` (a block makes the agent continue with the reason), Notification → when Octocode asks
 * the user something or an answer waits (side effects only). Each source keeps its own profile: `.claude` files the
 * Claude rules, `.codex` files the Codex rules, Octocode files the native contract. Project files load only after
 * `/trust`, plugin hooks once the plugin is added or enabled, and any loaded `disableAllHooks: true` turns them all off.
 * Octocode's PreMessageSend gates team/API/external sends; PostMessageReceive observes actual delivery without changing
 * the body or requesting a reply.
 */
/**
 * Every main session runs every hook. A subagent runs none by default (`sessionHookMode`): a hook meant for the main
 * session (a Stop hook that runs the tests, a notifier) would otherwise fire once per child. Its profile or its task can
 * choose `decisions` (`registerDecisionHooks`) or `all`.
 */
/** The stand-in for background hooks where none may start. */
const NO_BACKGROUND: ReturnType<typeof registerBackgroundHooks> = { reset: async () => {}, start: () => {} };

/**
 * A subagent in the `decisions` mode: the PreToolUse hooks run as a tool-call gate and the PermissionRequest hooks
 * answer an approval about to be asked. A refusal refuses the call and a PreToolUse ask goes to the permission gate,
 * which relays it to the parent or refuses it as it does the child's other approvals. An allow grants nothing, no
 * context is injected, no input rewritten, and no other event (Stop, SessionStart, notifiers) runs. A hook that fails or
 * times out fails open as in a main session, unless it is `failClosed`.
 */
function registerDecisionHooks(
	api: ExtensionAPI,
	view: HooksView,
	session: HookSession,
	patches: Map<string, string>,
	options: {
		env: NodeJS.ProcessEnv;
		home?: string;
		timings: Map<string, HookTiming>;
		onFailure?: HookFailureSink;
		metadata?: () => HookHostMetadata;
		paused?: () => boolean;
		projectEdit?: EditProjector;
	},
): void {
	const { paused } = options;
	const runner = createDispatcher(
		api,
		session,
		options.timings,
		options.onFailure,
		NO_BACKGROUND,
		true,
		options.metadata,
		paused,
		options.env[PARENT_SESSION_ENV],
		true,
	);
	view.suspend = () => runner.stop();
	api.on("session_start", async (_event, ctx) => {
		patches.clear();
		loadSessionHooks(api, session, ctx, options.home, true);
	});
	api.on("session_shutdown", async () => {
		patches.clear();
	});
	api.on("turn_end", async () => {
		patches.clear();
	});
	view.hasPreToolUse = preToolUseMatcher(session, paused);
	view.preToolUse = preToolUseGate(api, runner.dispatch, session, patches, options.projectEdit);
	view.permissionRequest = permissionRequestHook(
		session,
		runner.dispatch,
		options.onFailure,
		options.projectEdit,
		true,
	);
}

const preToolUseMatcher =
	(session: HookSession, paused?: () => boolean): HooksView["hasPreToolUse"] =>
	(toolName, input, cwd) =>
		!paused?.() &&
		hookCalls(toolName, input, cwd).some((call, index) =>
			commandsFor(session.config, "PreToolUse", call.names).some(
				ifFilter(toolName, input, cwd, toolName === "file" ? index : undefined),
			),
		);

/** What `registerHooks` needs from its host; every field is optional. */
interface HooksOptions {
	/** Says whether this is a subagent and which hook mode it runs (`process.env` by default). */
	env?: NodeJS.ProcessEnv;
	/** The user's home for user-level hook files (the OS home by default). */
	home?: string;
	/** Records a hook's failure or decision in the permission audit. */
	onFailure?: HookFailureSink;
	/** The permission mode and agent identity a hook's input carries. */
	metadata?: () => HookHostMetadata;
	/** True while planning pauses the hooks. */
	paused?: () => boolean;
	/** The file tool's projection of edit queries for Codex apply_patch hooks; without it those edits are refused. */
	projectEdit?: EditProjector;
}

export function registerHooks(api: ExtensionAPI, options: HooksOptions = {}): HooksView {
	const { env = process.env, home, onFailure, metadata, paused, projectEdit } = options;
	const session: HookSession = { config: emptyHooks(), errors: [], root: undefined };
	const mode = sessionHookMode(env);
	const enabled = mode === "all";
	const timings = new Map<string, HookTiming>();
	const view: HooksView = {
		summary: () =>
			enabled
				? paused?.()
					? "paused during planning"
					: `on, ${plural(hookCount(session.config), "hook")}`
				: CHILD_MODE_NOTE[mode],
		promptSection: () => (enabled && !paused?.() ? hooksPromptSection(session.config) : ""),
		report: (cwd) => hooksReport(mode, session.config, session.errors, cwd, home, timings, session.switchedOff),
		testRun: async () => `${CHILD_MODE_NOTE[mode]}. Test runs are off here.`,
		preToolUse: async () => undefined,
		permissionRequest: async () => undefined,
		hasFilePermissionRequest: () => false,
		hasPreToolUse: () => false,
		fileInputCommitted: () => {},
		notification: () => undefined,
		messageSend: async () => undefined,
		messageReceive: async () => undefined,
	};
	// Registered even when hooks are off: a resumed session may hold Stop feedback from an earlier run.
	registerStopRenderer(api);
	const patches = new Map<string, string>();
	if (mode === "off") return view;
	if (mode === "decisions") {
		registerDecisionHooks(api, view, session, patches, {
			env,
			home,
			timings,
			onFailure,
			metadata,
			paused,
			projectEdit,
		});
		return view;
	}
	const background = registerBackgroundHooks(api);
	const child = envFlag(env, SUBAGENT_ENV);
	const parentSession = child ? env[PARENT_SESSION_ENV] : undefined;
	const runner = createDispatcher(api, session, timings, onFailure, background, child, metadata, paused, parentSession);
	view.testRun = (ctx, words) => testRunHooks(runner.dispatch, session, ctx, words);
	view.suspend = async () => {
		await Promise.all([runner.stop(), background.reset(false)]);
	};
	// The message handlers go first: their session_start reset runs before the hook files load.
	Object.assign(view, registerMessageHooks(api, runner));
	registerStopHook(api, session, runner.dispatch, child);
	registerSessionStartHooks(api, session, runner, home, child);
	if (child) registerSubagentHooks(api, session, runner.dispatch, env, metadata);
	api.on("session_start", async () => {
		patches.clear();
	});
	api.on("session_shutdown", async () => {
		patches.clear();
	});
	api.on("turn_end", async () => {
		patches.clear();
	});
	view.hasPreToolUse = preToolUseMatcher(session, paused);
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

	view.permissionRequest = permissionRequestHook(session, runner.dispatch, onFailure, projectEdit);
	view.preToolUse = preToolUseGate(api, runner.dispatch, session, patches, projectEdit);
	view.notification = notificationHook(api, runner);
	registerPostToolUseHook(api, runner.dispatch, session, patches);
	registerPreCompactHook(api, runner.dispatch);
	if (!child) registerInterruptHook(api, session, runner.dispatch, metadata);
	registerPromptHook(api, runner.dispatch);
	registerPostCompactHook(api, runner.dispatch);
	registerPostToolBatchHook(api, runner.dispatch);
	registerAgentHooks(api, session, runner);
	registerSessionEndHook(api, session, runner.dispatch, env);
	return view;
}
