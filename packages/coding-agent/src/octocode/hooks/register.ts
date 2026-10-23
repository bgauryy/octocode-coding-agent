import type { FileInputReplacement } from "../shared/claude-file.ts";
import { rewriteClaudeBash } from "../shared/claude-bash.ts";
import type { ToolInvocation } from "../../core/extensions/types.ts";
import { sha256 } from "../shared/atomic.ts";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import { validateFileInput } from "../shared/file-input.ts";
import { registerBackgroundHooks } from "./background.ts";
import { limitCodexContext } from "./context-limit.ts";
import { createPromptEvaluator, interpretPromptHook } from "./prompt.ts";
import { rewriteFileQuery, rewriteCodexCommand } from "./rewrite.ts";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { getMcpHookCaller } from "../../extensions/mcp/hook-caller.ts";
import { Box, Text } from "@octocodeai/octocode-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/index.ts";
import { notify, type Subcommands, say } from "../shared/commands.ts";
import {
	envFlag,
	HOOKS_COMPAT_ENV,
	HOOKS_ENV,
	SUBAGENT_ENV,
	PARENT_SESSION_ENV,
	PARENT_TRANSCRIPT_ENV,
} from "../shared/env.ts";
import { formatDuration } from "../shared/format.ts";
import { configFileLines, repoKey, tildePath } from "../shared/home.ts";
import { EXTERNAL_MESSAGE_TYPE, INTERNAL_MESSAGE_TYPE, type MessageEnvelope } from "../shared/messages.ts";
import { resultBlock } from "../shared/render.ts";
import { redactSecrets, sanitizeTerminalText, visibleControls } from "../shared/sanitize.ts";
import { STATUS } from "../shared/status.ts";
import { projectTrust } from "../shared/trust.ts";
import { clipText, contentText, errorMessage, firstLine, isRecord } from "../shared/util.ts";
import {
	commandsFor,
	emptyHooks,
	HOOK_EVENTS,
	type HookHandler,
	hookLabel,
	type HookConfig,
	type HookEvent,
	hookCalls,
	hookFiles,
	hookIdentity,
	loadHooks,
} from "./config.ts";
import { CODEX_PATCH_NAMES, projectCodexPatch, rewriteCodexPatch } from "./patch.ts";
import { claudeSessionEndOverride, hookPayload, type HookProtocol } from "./profiles.ts";
import { capContext, failureOf, type HookVerdict, interpret, runHook } from "./runner.ts";

/**
 * Optional adapter for Claude Code / Codex command hooks, adapted from the native host's hook dispatcher:
 * PreToolUse → `tool_call` (can block), PostToolUse → `tool_result` (can add feedback), SessionStart (also after a
 * compaction, source `compact`) → context for the next prompt, PreCompact → `session_before_compact` (side effects
 * only), Stop → `agent_before_settle` (a block makes the agent continue with the reason), Notification → when Octocode asks
 * the user something or an answer waits (side effects only). Off unless `OCTOCODE_HOOKS=1`, because hooks written for
 * another agent run arbitrary commands. Octocode's PreMessageSend gates team/API/external sends; PostMessageReceive
 * observes actual delivery without changing the body or requesting a reply.
 */
const CONTEXT_TYPE = "octocode-hook-context";
/** Longest the first prompt waits for SessionStart hooks still running. */
const START_HOOKS_WAIT_MS = 15_000;
const STOP_TYPE = "octocode-hook-stop";
const STOP_PREFIX = "Stop hook feedback:\n";
/** Claude Code's cap on consecutive Stop-hook continuations; a tool call resets the count. */
const STOP_CONTINUE_CAP = 8;
/** A hook run this slow is reported once: PreToolUse hooks hold back every call of the batch. */
const SLOW_HOOK_MS = 5_000;

/**
 * Shows `label` in the footer status while `work` runs, with its elapsed time in the TUI. For hooks that run after Octocode
 * removed its working indicator (Stop runs after `agent_end`): without it a slow hook looks like a finished, stuck run.
 */
async function withStatus<T>(ctx: ExtensionContext, label: string, work: () => Promise<T>): Promise<T> {
	if (!ctx.hasUI) return work();
	const started = Date.now();
	const show = () => {
		const ms = Date.now() - started;
		ctx.ui.setStatus(STATUS.hooks, `${label}${ms >= 1_000 ? ` · ${formatDuration(ms)}` : ""}`);
	};
	show();
	// RPC clients get the label once; only the TUI repaints the time.
	const timer = ctx.mode === "tui" ? setInterval(show, 1_000) : undefined;
	timer?.unref?.();
	try {
		return await work();
	} finally {
		if (timer) clearInterval(timer);
		try {
			ctx.ui.setStatus(STATUS.hooks, undefined);
		} catch {
			// The session was replaced.
		}
	}
}

/** `Stop hook: <command>` (`+N` for the others): one line, its secrets redacted. */
function hooksLabel(event: HookEvent, hooks: HookHandler[]): string {
	const command = clipText(firstLine(redactSecrets(sanitizeTerminalText(hooks[0] ? hookLabel(hooks[0]) : ""))), 48);
	return `${event} hook: ${command}${hooks.length > 1 ? ` +${hooks.length - 1}` : ""}`;
}

/** Time each hook command took, for `/hooks`. */
interface HookTiming {
	runs: number;
	totalMs: number;
	maxMs: number;
}

/** What a Notification hook receives besides the common fields (Claude Code's shape). */
interface HookNotice {
	message: string;
	title?: string;
	/** Claude Code's `notification_type`: `permission_prompt`, `elicitation_dialog` or `idle_prompt`. */
	type: string;
}

const hooksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => envFlag(env, HOOKS_ENV);

/** Octocode's session start reasons in Claude Code's SessionStart matcher vocabulary. */
const START_SOURCE: Record<string, string> = {
	startup: "startup",
	reload: "startup",
	new: "clear",
	resume: "resume",
	fork: "fork",
};

const hookCount = (config: HookConfig): number =>
	HOOK_EVENTS.reduce((sum, event) => sum + config[event].reduce((n, group) => n + group.hooks.length, 0), 0);

/** What `/hooks` and `/octocode` show about hooks. */
interface HooksView {
	hasFilePermissionRequest(input: Record<string, unknown>, cwd: string): boolean;
	fileInputCommitted(id: string, input: Record<string, unknown>): void;
	permissionRequest(
		invocation: ToolInvocation,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<
		| {
				decision: "allow" | "deny";
				message?: string;
				interrupt?: boolean;
				updatedInput?: import("@octocodeai/octocode-ai").JsonObject;
				updatedFileInputs?: FileInputReplacement[];
				updatedPermissions?: import("../shared/permission-updates.ts").SourcePermissionUpdate[];
		  }
		| undefined
	>;
	/** One line for the `/octocode` status. */
	summary(): string;
	/** On/off, the loaded commands per event, the files read (✓ = exists) and any config errors. */
	report(cwd: string): string;
	/** The PreToolUse hooks as a tool-call gate (a no-op while hooks are off); `ask` carries a hook's ask to the permission gate. */
	preToolUse(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<(ToolCallEventResult & { ask?: string; rewritten?: true }) | undefined>;
	/** Runs the Notification hooks matching `notice.type` in the background (a no-op while hooks are off). */
	notification(notice: HookNotice, ctx: ExtensionContext): void;
	messageSend(message: MessageEnvelope, ctx: ExtensionContext): Promise<{ block?: string; ask?: string } | undefined>;
	messageReceive(message: MessageEnvelope, ctx: ExtensionContext): Promise<void>;
}

function receivedMessages(value: unknown): MessageEnvelope[] {
	if (!isRecord(value) || value.role !== "custom" || !isRecord(value.details)) return [];
	if (value.customType !== INTERNAL_MESSAGE_TYPE && value.customType !== EXTERNAL_MESSAGE_TYPE) return [];
	const envelope = value.details.message;
	if (
		isRecord(envelope) &&
		(envelope.channel === "internal" || envelope.channel === "external") &&
		typeof envelope.from === "string" &&
		typeof envelope.to === "string" &&
		typeof envelope.text === "string" &&
		typeof envelope.id === "string"
	) {
		return [
			{
				channel: envelope.channel,
				direction: "inbound",
				from: envelope.from,
				to: envelope.to,
				text: envelope.text,
				id: envelope.id,
				...(typeof envelope.replyTo === "string" ? { replyTo: envelope.replyTo } : {}),
			},
		];
	}
	if (value.customType !== INTERNAL_MESSAGE_TYPE || !Array.isArray(value.details.messages)) return [];
	return value.details.messages.flatMap((message): MessageEnvelope[] => {
		if (
			!isRecord(message) ||
			typeof message.id !== "number" ||
			typeof message.from !== "string" ||
			typeof message.to !== "string" ||
			typeof message.text !== "string"
		)
			return [];
		return [
			{
				channel: "internal",
				direction: "inbound",
				from: message.from,
				to: message.to,
				text: message.text,
				id: String(message.id),
				...(typeof message.replyTo === "number" ? { replyTo: String(message.replyTo) } : {}),
			},
		];
	});
}

const messageKey = (message: MessageEnvelope): string | undefined =>
	message.id === undefined
		? undefined
		: JSON.stringify([message.channel, message.direction, message.from, message.to, message.id]);
const messageNames = (message: MessageEnvelope): string[] => [
	message.channel,
	`${message.channel}.${message.direction}`,
];

function timingText(timing: HookTiming | undefined): string {
	if (!timing) return "";
	return ` · ${timing.runs} run${timing.runs === 1 ? "" : "s"}, avg ${formatDuration(timing.totalMs / timing.runs)}, max ${formatDuration(timing.maxMs)}`;
}

function hooksReport(
	enabled: boolean,
	config: HookConfig,
	errors: string[],
	cwd: string,
	home?: string,
	timings = new Map<string, HookTiming>(),
	sourceProfiles = false,
): string {
	const loaded = HOOK_EVENTS.flatMap((event) =>
		config[event].flatMap((group) =>
			group.hooks.map((hook) => {
				const command = clipText(hookLabel(hook), 80);
				return `  ${event} [${group.matcher || "*"}] ${command}${hook.failClosed ? " [failClosed]" : ""} (${tildePath(hook.source, home)})${timingText(timings.get(`${event}\0${hookIdentity(hook)}`))}${hook.origins?.length ? ` [source ${hook.origins[0]!.dialect}; runtime ${hook.protocol ?? "octocode"}]` : ""}`;
			}),
		),
	);
	return [
		enabled ? `Hooks: on (${HOOKS_ENV}=1)` : `Hooks: off. Start Octocode with ${HOOKS_ENV}=1 to run them.`,
		...(enabled ? [`Loaded (${loaded.length}):`, ...(loaded.length > 0 ? loaded : ["  none"])] : []),
		"",
		`Hook files (supported hook subset, {"hooks": {...}}; events ${HOOK_EVENTS.join(", ")}):`,
		...configFileLines(hookFiles(cwd, true, home, sourceProfiles), hookFiles(cwd, false, home, sourceProfiles), home),
		...(errors.length > 0 ? ["", "Hook configuration diagnostics:", ...errors.map((error) => `  ${error}`)] : []),
	].join("\n");
}

/** Records a `PreToolUse` hook that gave no answer (`allowed`: the call went ahead) in the permission audit. */
type HookFailureSink = (what: readonly string[], note: string, allowed: boolean) => void;

/** What every event handler shares: the loaded config (replaced on each session start) and the repository root. */
interface HookSession {
	config: HookConfig;
	errors: string[];
	/** The repository root for CLAUDE_PROJECT_DIR, found once per session and only when a hook actually runs. */
	root: string | undefined;
}

type Dispatch = (
	ctx: ExtensionContext,
	event: HookEvent,
	names: string[],
	input: () => Record<string, unknown>,
	signal?: AbortSignal,
	protocol?: HookProtocol | readonly HookProtocol[],
) => Promise<HookVerdict>;
interface HookHostMetadata {
	permissionMode?: "manual" | "workspace" | "full";
	agentName?: string;
	agentType?: string;
}

type ReportFailure = (ctx: ExtensionContext, event: HookEvent, error: unknown) => void;

/** The shared hook runner: `dispatch` runs the hooks of one event, `reportFailure` says once per event that a dispatch itself failed. */
function createDispatcher(
	pi: ExtensionAPI,
	session: HookSession,
	timings: Map<string, HookTiming>,
	onFailure: HookFailureSink | undefined,
	background: ReturnType<typeof registerBackgroundHooks> | undefined,
	child: boolean,
	metadata: (() => HookHostMetadata) | undefined,
): { dispatch: Dispatch; reportFailure: ReportFailure } {
	/** Commands already reported as slow, so each is reported once per Octocode process. */
	const slowWarned = new Set<string>();
	const timeHook = async (
		ctx: ExtensionContext,
		event: HookEvent,
		hook: HookHandler,
		run: () => ReturnType<typeof runHook>,
	): ReturnType<typeof runHook> => {
		const started = Date.now();
		const result = await run();
		const ms = Date.now() - started;
		const key = `${event}\0${hookIdentity(hook)}`;
		const timing = timings.get(key) ?? { runs: 0, totalMs: 0, maxMs: 0 };
		timings.set(key, { runs: timing.runs + 1, totalMs: timing.totalMs + ms, maxMs: Math.max(timing.maxMs, ms) });
		if (
			ms >= SLOW_HOOK_MS &&
			!slowWarned.has(key) &&
			ctx.hasUI &&
			!((hook.type === undefined || hook.type === "command") && (hook.async || hook.asyncRewake)) &&
			event !== "SessionStart" &&
			event !== "Notification"
		) {
			slowWarned.add(key);
			const why = event === "PreToolUse" ? ": every tool call in a batch waits for it" : "";
			notify(ctx.ui, `Slow ${event} hook (${formatDuration(ms)})${why}. ${clipText(hookLabel(hook), 80)}`, "warning");
		}
		return result;
	};

	/** Hooks already warned about for a failure, so each is shown once per Octocode process (every failure is audited). */
	const failureWarned = new Set<string>();
	/**
	 * A `PreToolUse` hook gave no answer. Hooks fail open, so the call goes ahead unless the hook is `failClosed`; either
	 * way the user sees a warning (once per hook, with a UI) and the audit records it. Returns the block reason when failing closed.
	 */
	const hookFailed = (
		ctx: ExtensionContext,
		hook: HookHandler,
		failure: string,
		target: string,
		event: "PreToolUse" | "PreMessageSend",
	): string | undefined => {
		const failurePolicy = hook.onFailure === "block" ? 'onFailure: "block"' : "failClosed";
		const closed = hook.failClosed === true || hook.onFailure === "block";
		const command = clipText(firstLine(redactSecrets(visibleControls(hookLabel(hook)))), 80);
		onFailure?.(
			[`${event} hook ${failure}: ${command}`, `${event === "PreToolUse" ? "tool" : "message"}: ${target}`],
			closed ? `hook failed; ${failurePolicy} denied the call` : "hook failed; hooks fail open, the call was allowed",
			!closed,
		);
		const key = `${event}\0${hookIdentity(hook)}`;
		if (ctx.hasUI && !failureWarned.has(key)) {
			failureWarned.add(key);
			notify(
				ctx.ui,
				`${event} hook ${failure}: ${command}. ${closed ? `The call was denied (${failurePolicy}).` : 'The call was allowed (hooks fail open); set "failClosed": true on the hook to deny instead.'}`,
				"warning",
			);
		}
		return closed ? `${event} hook ${failure} and is set to ${failurePolicy}: ${command}` : undefined;
	};

	/**
	 * Runs the hooks matching `names` in parallel, as Claude Code does; any block blocks, and verdicts combine in
	 * config order. Most tool calls match no hook, so the input (which may join a large tool result) is built only when
	 * one does.
	 */
	const dispatch: Dispatch = async (ctx, event, names, input, signal = ctx.signal, protocol) => {
		const hooks = commandsFor(session.config, event, names).filter(
			(hook) =>
				!protocol ||
				(typeof protocol === "string"
					? (hook.protocol ?? "octocode") === protocol
					: protocol.includes(hook.protocol ?? "octocode")),
		);
		if (hooks.length === 0) return {};
		session.root ??= repoKey(ctx.cwd).root;
		const payload: Record<string, unknown> = {
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? "",
			cwd: ctx.cwd,
			hook_event_name: event,
			...input(),
		};
		const env = { CLAUDE_PROJECT_DIR: session.root };
		const hostMetadata = metadata?.();
		const dispatchMetadata = {
			...hostMetadata,
			model: ctx.model?.id,
			turnId: ctx.getTurnId?.(),
			child: child
				? {
						sessionId: ctx.sessionManager.getSessionId(),
						agentName: hostMetadata?.agentName,
						agentType: hostMetadata?.agentType || "general",
					}
				: undefined,
		};
		const race = event === "PermissionRequest" && protocol === "claude" ? new AbortController() : undefined;
		let winner: HookVerdict | undefined;
		const runOne = async (hook: HookHandler, signal: AbortSignal | undefined): Promise<HookVerdict> => {
			if (hook.configurationError && event === "PermissionRequest") {
				say(ctx, hook.configurationError, "warning");
				onFailure?.(["PermissionRequest"], hook.configurationError, false);
				return { permissionDecision: "deny", block: hook.configurationError };
			}
			if (hook.configurationError && event === "UserPromptSubmit") return { block: hook.configurationError };
			if (hook.configurationError && (event === "PreToolUse" || event === "PreMessageSend")) {
				return {
					block: hookFailed(ctx, hook, hook.configurationError, String(payload.tool_name ?? "message"), event),
				};
			}
			if (
				(hook.type === undefined || hook.type === "command") &&
				hook.protocol !== "octocode" &&
				event !== "SessionEnd" &&
				(hook.async || hook.asyncRewake) &&
				background
			) {
				if (!signal?.aborted)
					background.start(
						hook,
						event,
						(backgroundSignal) =>
							timeHook(ctx, event, hook, () =>
								runHook(
									hook,
									hookPayload(hook.protocol ?? "octocode", payload, dispatchMetadata),
									ctx.cwd,
									env,
									backgroundSignal,
								),
							),
						(message) => say(ctx, message, "warning"),
					);
				return {};
			}
			const run = await timeHook(ctx, event, hook, () =>
				runHook(
					hook,
					hookPayload(hook.protocol ?? "octocode", payload, dispatchMetadata),
					ctx.cwd,
					env,
					signal,
					getMcpHookCaller(pi.events),
					hook.type === "prompt" ? createPromptEvaluator(ctx) : undefined,
				),
			);
			if (race && signal?.aborted) return {};
			const verdict =
				hook.type === "prompt"
					? event === "PermissionRequest"
						? {}
						: interpretPromptHook(event, run, hook.continueOnBlock)
					: interpret(event, run, hook.protocol);
			if (verdict.systemMessage) say(ctx, verdict.systemMessage, "warning");
			if (hook.protocol === "codex" && verdict.context)
				verdict.context = limitCodexContext(verdict.context, hook.additionalContextLimit);
			const gate = event === "PreToolUse" || event === "PreMessageSend" ? event : undefined;
			const failure = !signal?.aborted ? (verdict.error ?? failureOf(hook, run, false)) : undefined;
			const message = isRecord(payload.message) ? payload.message : {};
			const target = gate === "PreMessageSend" ? `${message.from} -> ${message.to}` : String(payload.tool_name ?? "");
			const block =
				failure && gate
					? hookFailed(ctx, hook, failure, target, gate)
					: failure &&
						  hook.onFailure === "block" &&
						  (event === "PreCompact" ||
								event === "PostToolUse" ||
								event === "PostToolBatch" ||
								event === "UserPromptSubmit")
						? `${event} hook ${failure}; onFailure: "block"`
						: undefined;
			if (failure && !gate && hook.protocol && (ctx.hasUI || event === "Interrupt" || event === "PermissionRequest")) {
				const key = `${event}\0${hookIdentity(hook)}`;
				if (!failureWarned.has(key)) {
					failureWarned.add(key);
					say(
						ctx,
						`${event} hook ${failure}: ${clipText(redactSecrets(visibleControls(hookLabel(hook))), 80)}`,
						"warning",
					);
				}
			}
			if (failure && event === "PermissionRequest") onFailure?.([`PermissionRequest ${target}`], failure, false);
			const outcome =
				failure && event === "PermissionRequest" && (hook.failClosed || hook.onFailure === "block")
					? { permissionDecision: "deny" as const, block: failure }
					: block
						? { ...verdict, block }
						: verdict;
			return event === "PreCompact" && hook.protocol && hook.protocol !== "octocode" && outcome.block
				? { ...outcome, cancelCompaction: true }
				: outcome;
		};
		const running = hooks.map(async (hook) => {
			let verdict: HookVerdict;
			try {
				verdict = await runOne(hook, race ? (signal ? AbortSignal.any([signal, race.signal]) : race.signal) : signal);
			} catch (error) {
				if (!race) throw error;
				if (winner || signal?.aborted) return {};
				const message = errorMessage(error);
				say(ctx, message, "warning");
				verdict =
					hook.failClosed || hook.onFailure === "block"
						? { permissionDecision: "deny", block: message }
						: { error: message };
			}
			if (race && !winner && !signal?.aborted && verdict.permissionDecision) {
				winner = verdict;
				race.abort();
			}
			return verdict;
		});
		if (race) {
			await Promise.allSettled(running);
			return signal?.aborted ? {} : (winner ?? {});
		}
		const verdicts = await Promise.all(running);
		if (event === "PermissionRequest") {
			const deny =
				verdicts.find((verdict) => verdict.permissionDecision === "deny" && verdict.permissionInterrupt) ??
				verdicts.find((verdict) => verdict.permissionDecision === "deny");
			if (deny)
				return {
					permissionDecision: "deny",
					block: deny.block,
					...(verdicts.some((verdict) => verdict.permissionInterrupt) ? { permissionInterrupt: true } : {}),
				};
			return verdicts.some((verdict) => verdict.permissionDecision === "allow") ? { permissionDecision: "allow" } : {};
		}
		if ((event === "Stop" || event === "SubagentStop") && verdicts.some((verdict) => verdict.stop))
			return { stop: true };
		const halted = verdicts.find((verdict) => verdict.haltTurn);
		if (halted) {
			say(ctx, halted.block ?? halted.context ?? "Stopped by a prompt hook", "warning");
			ctx.abort("internal");
		}
		const rewrites = verdicts.flatMap((verdict) => (verdict.updatedInput ? [verdict.updatedInput] : []));
		if (rewrites.length > 1 && rewrites.some((value) => JSON.stringify(value) !== JSON.stringify(rewrites[0])))
			return { block: "Conflicting hook input rewrites; call not executed" };
		const block = verdicts
			.map((verdict) => verdict.block)
			.filter(Boolean)
			.join("\n\n");
		const context = verdicts
			.map((verdict) => verdict.context)
			.filter(Boolean)
			.join("\n\n");
		const ask = verdicts
			.map((verdict) => verdict.ask)
			.filter(Boolean)
			.join("\n\n");
		return {
			...(rewrites[0]
				? {
						updatedInput: rewrites[0],
						updatedInputProtocol: verdicts.find((verdict) => verdict.updatedInput)?.updatedInputProtocol,
					}
				: {}),
			...(verdicts.some((verdict) => verdict.continueReason)
				? {
						continueReason: capContext(
							verdicts
								.map((verdict) => verdict.continueReason)
								.filter(Boolean)
								.join("\n\n"),
						),
					}
				: {}),
			...(verdicts.some((verdict) => verdict.replaceResult) ? { replaceResult: true as const } : {}),
			...(verdicts.some((verdict) => verdict.rejectNested) ? { rejectNested: true as const } : {}),
			...(event === "PostCompact" && verdicts.some((verdict) => verdict.stop) ? { stop: true as const } : {}),
			...(verdicts.some((verdict) => verdict.cancelCompaction) ? { cancelCompaction: true as const } : {}),
			...(block ? { block: capContext(block) } : {}),
			...(context ? { context: event === "SubagentStart" ? context : capContext(context) } : {}),
			...(ask ? { ask: capContext(ask) } : {}),
		};
	};

	/** A dispatch that itself failed (not a hook's verdict): reported once per event per Octocode process, with a UI. */
	const dispatchWarned = new Set<HookEvent>();
	const reportFailure: ReportFailure = (ctx, event, error) => {
		if (dispatchWarned.has(event)) return;
		dispatchWarned.add(event);
		try {
			if (ctx.hasUI) notify(ctx.ui, `${event} hooks could not run: ${errorMessage(error)}`, "warning");
		} catch {
			// The session was replaced.
		}
	};

	return { dispatch, reportFailure };
}

/**
 * SessionStart (also after a compaction, source `compact`): loads the hook config on each session start, runs the
 * SessionStart hooks, and hands their context to the next prompt.
 */
function registerSessionStartHooks(
	pi: ExtensionAPI,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
	home: string | undefined,
	sourceProfiles: boolean,
	child = false,
): void {
	let pending: string[] = [];
	/** SessionStart hook commands still running: the next prompt waits for their context, session start does not. */
	let starting: Promise<void> | undefined;
	/** Ends the current session's SessionStart hooks (on shutdown or the next session start), so none outlive it. */
	let startAbort = new AbortController();

	/**
	 * Starts the SessionStart hooks matching `source`. Hook commands can be slow (they spawn processes): they run
	 * without holding up the event. A result that arrives after the session was replaced belongs to the old one and is
	 * dropped. A session start ends the previous session's runs; a compaction's run joins any still going.
	 */
	const startHooks = (ctx: ExtensionContext, source: string, fresh: boolean): void => {
		if (fresh) {
			startAbort.abort();
			startAbort = new AbortController();
		}
		const abort = startAbort;
		const previous = fresh ? undefined : starting;
		const hooks = Promise.all(
			(["octocode", "claude", "codex"] as const)
				.filter((protocol) => !child || protocol === "octocode")
				.map((protocol) => {
					const profileSource = protocol === "octocode" && source === "fork" ? "resume" : source;
					return dispatch(
						ctx,
						"SessionStart",
						[profileSource],
						() => ({ source: profileSource }),
						abort.signal,
						protocol,
					);
				}),
		)
			.then((verdicts) => {
				if (!abort.signal.aborted) for (const verdict of verdicts) if (verdict.context) pending.push(verdict.context);
			})
			.catch((error: unknown) => {
				if (!abort.signal.aborted) reportFailure(ctx, "SessionStart", error);
			});
		const run: Promise<void> = (previous ? Promise.all([previous, hooks]) : hooks)
			.then(() => undefined)
			.finally(() => {
				if (starting === run) starting = undefined;
			});
		starting = run;
	};

	pi.on("session_start", async (event, ctx) => {
		const loaded = loadHooks(ctx.cwd, await projectTrust(ctx), home, {
			sourceProfiles,
			plugins: pi.getSettings().plugins,
		});
		session.config = loaded.config;
		session.errors = loaded.errors;
		session.root = undefined;
		pending = [];
		if (loaded.errors.length > 0 && ctx.hasUI)
			notify(ctx.ui, `Hook configuration diagnostics: ${loaded.errors.join("; ")}`, "warning");
		startHooks(ctx, START_SOURCE[event.reason] ?? "startup", true);
	});
	// Claude Code runs SessionStart again (source `compact`) after a compaction: its context comes with the next prompt.
	pi.on("session_compact", async (_event, ctx) => startHooks(ctx, "compact", false));
	pi.on("session_shutdown", async () => startAbort.abort());

	// SessionStart context reaches the model once, with the next prompt, as data rather than instructions.
	pi.on("before_agent_start", async (_event, ctx) => {
		// The first prompt waits a bounded time for their context; a slower hook's context comes with the next prompt.
		if (starting) {
			// Shown only while the prompt actually waits: `starting` clears itself once the hooks finish.
			if (ctx.hasUI) ctx.ui.setStatus(STATUS.hooks, "Waiting for SessionStart hooks…");
			try {
				await Promise.race([starting, new Promise((resolve) => setTimeout(resolve, START_HOOKS_WAIT_MS).unref())]);
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS.hooks, undefined);
			}
		}
		if (pending.length === 0) return undefined;
		const content = capContext(`Context from SessionStart hooks:\n${pending.join("\n\n")}`);
		pending = [];
		return { message: { customType: CONTEXT_TYPE, content, display: false } };
	});
}

/**
 * Native and Claude file hooks run once per query. Codex receives one whole-batch apply_patch call.
 * All pre-call decisions run in parallel; any denial blocks the native batch.
 */
const preToolUseGate =
	(pi: ExtensionAPI, dispatch: Dispatch, session: HookSession, patches: Map<string, string>): HooksView["preToolUse"] =>
	async (event, ctx) => {
		if (event.toolName === "file") {
			try {
				validateFileInput(event.input);
			} catch (error) {
				return { block: true, reason: errorMessage(error) };
			}
		}
		if (event.toolName === "file" && typeof event.input.patch === "string") {
			try {
				const patch = parsePatch(event.input.patch);
				if (
					patch.hunks.some((h) => h.kind === "update") &&
					commandsFor(session.config, "PreToolUse", ["file", "Edit", "MultiEdit", "Write", "Delete"]).some(
						(h) => h.protocol !== "codex",
					)
				) {
					return {
						block: true,
						reason:
							"Canonical Update/Move patches cannot be represented losslessly to matching native or Claude PreToolUse hooks; use native file queries",
					};
				}
			} catch (error) {
				return { block: true, reason: errorMessage(error) };
			}
		}
		const calls = hookCalls(event.toolName, event.input, ctx.cwd);
		const dispatches =
			event.toolName === "file"
				? calls.flatMap((call, index) =>
						(["octocode", "claude"] as const).map((protocol) => ({ ...call, index, protocol })),
					)
				: calls.map((call, index) => ({ ...call, index, protocol: undefined as HookProtocol | undefined }));
		const codexGate =
			event.toolName === "file" &&
			commandsFor(session.config, "PreToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
		const codexPost =
			event.toolName === "file" &&
			commandsFor(session.config, "PostToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
		if (codexGate || codexPost) {
			try {
				const command = projectCodexPatch(event.input);
				patches.set(event.toolCallId, command);
				if (codexGate)
					dispatches.push({
						names: CODEX_PATCH_NAMES,
						tool_name: "apply_patch",
						tool_input: { command },
						index: -1,
						protocol: "codex",
					});
			} catch (error) {
				if (codexGate)
					return { block: true, reason: `Cannot run matching Codex apply_patch hook: ${errorMessage(error)}` };
			}
		}
		const verdicts = await Promise.all(
			dispatches.map((call) =>
				dispatch(
					ctx,
					"PreToolUse",
					call.names,
					() => ({
						tool_use_id: event.toolCallId,
						tool_name: call.tool_name,
						pi_tool_name: event.toolName,
						tool_input: call.tool_input,
					}),
					ctx.signal,
					call.protocol,
				),
			),
		);
		const block = verdicts.find((verdict) => verdict.block)?.block;
		if (block) return { block: true, reason: `Blocked by a PreToolUse hook: ${block}` };
		const rewrites = verdicts.flatMap((verdict) => (verdict.updatedInput ? [verdict.updatedInput] : []));
		let rewritten = false;
		if (rewrites.length) {
			if (
				event.toolCallId === "user-bash" ||
				["read", "edit", "write"].includes(event.toolName) ||
				(event.toolName !== "file" && calls.length !== 1)
			)
				return {
					block: true,
					reason: "Input rewrite requires an unavailable reverse adapter for this tool; call not executed",
				};
			const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
			if (!definition) return { block: true, reason: "Cannot validate rewritten input for an unknown tool" };
			try {
				let replacement: Record<string, unknown> = rewrites[0]!;
				if (
					event.toolName === "bash" &&
					verdicts.find((verdict) => verdict.updatedInput)?.updatedInputProtocol === "codex"
				)
					replacement = rewriteCodexCommand(event.input, rewrites[0]!);
				if (
					event.toolName === "bash" &&
					verdicts.find((verdict) => verdict.updatedInput)?.updatedInputProtocol === "claude"
				)
					replacement = rewriteClaudeBash(event.input, rewrites[0]!);
				if (event.toolName === "file") {
					const codexRewrite = verdicts.find(
						(verdict) => verdict.updatedInputProtocol === "codex" && verdict.updatedInput,
					)?.updatedInput;
					if (
						codexRewrite &&
						verdicts.some((verdict) => verdict.updatedInput && verdict.updatedInputProtocol !== "codex")
					)
						throw new Error("Conflicting source-profile file rewrites; call not executed");
					replacement = codexRewrite ? rewriteCodexPatch(event.input, codexRewrite) : structuredClone(event.input);
					if (!codexRewrite)
						for (const [index, verdict] of verdicts.entries())
							if (verdict.updatedInput) {
								if (verdict.updatedInputProtocol !== "claude") throw new Error("Unsupported file rewrite profile");
								replacement = rewriteFileQuery(replacement, dispatches[index]!.index, verdict.updatedInput);
							}
					if (codexGate || codexPost) {
						try {
							patches.set(
								event.toolCallId,
								codexRewrite ? String(codexRewrite.command) : projectCodexPatch(replacement),
							);
						} catch (error) {
							patches.delete(event.toolCallId);
							if (codexGate) throw error;
						}
					}
				}
				const validated = validateToolArguments(definition, {
					type: "toolCall",
					id: event.toolCallId,
					name: event.toolName,
					arguments: replacement as Parameters<typeof validateToolArguments>[1]["arguments"],
				});
				for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
				Object.assign(event.input, validated);
				rewritten = true;
			} catch (error) {
				return { block: true, reason: `Invalid hook input rewrite: ${errorMessage(error)}` };
			}
		}
		const context = verdicts
			.map((verdict) => verdict.context)
			.filter(Boolean)
			.join("\n\n");
		if (context && !ctx.signal?.aborted) {
			await pi.sendMessage(
				{ customType: CONTEXT_TYPE, content: capContext(`Context from PreToolUse hooks:\n${context}`), display: false },
				{ triggerTurn: false },
			);
		}
		const ask = verdicts
			.map((verdict) => verdict.ask)
			.filter(Boolean)
			.join("\n\n");
		return ask || rewritten
			? { ...(ask ? { ask: capContext(ask) } : {}), ...(rewritten ? { rewritten: true } : {}) }
			: undefined;
	};

/**
 * PreMessageSend gates a send; PostMessageReceive observes delivery. Tracks which session the messages belong to and
 * which were already seen (a resumed session replays its history), so each received message dispatches once.
 */
function registerMessageHooks(
	pi: ExtensionAPI,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): Pick<HooksView, "messageSend" | "messageReceive"> {
	let messageAbort = new AbortController();
	let messageSessionId: string | undefined;
	const received = new Set<string>();
	let receivedObjects = new WeakSet<MessageEnvelope>();

	pi.on("session_start", async (_event, ctx) => {
		messageAbort.abort();
		messageAbort = new AbortController();
		messageSessionId = undefined;
		received.clear();
		receivedObjects = new WeakSet();
		try {
			messageSessionId = ctx.sessionManager.getSessionId();
			for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
				const message =
					entry.type === "message"
						? entry.message
						: entry.type === "custom_message"
							? { role: "custom", ...entry }
							: undefined;
				for (const envelope of receivedMessages(message)) {
					const key = messageKey(envelope);
					if (key) received.add(key);
				}
			}
		} catch {
			messageAbort.abort();
		}
	});
	pi.on("session_shutdown", async () => messageAbort.abort());

	const messageSend: HooksView["messageSend"] = async (message, ctx) => {
		if (ctx.sessionManager.getSessionId() !== messageSessionId)
			throw new Error("The message belongs to a different session.");
		const signal = ctx.signal ? AbortSignal.any([messageAbort.signal, ctx.signal]) : messageAbort.signal;
		signal.throwIfAborted();
		const verdict = await dispatch(ctx, "PreMessageSend", messageNames(message), () => ({ message }), signal);
		signal.throwIfAborted();
		return verdict.block
			? { block: `Blocked by a PreMessageSend hook: ${verdict.block}` }
			: verdict.ask
				? { ask: verdict.ask }
				: undefined;
	};

	const messageReceive: HooksView["messageReceive"] = async (message, ctx) => {
		const signal = messageAbort.signal;
		if (signal.aborted) return;
		try {
			if (ctx.sessionManager.getSessionId() !== messageSessionId) return;
		} catch {
			return;
		}
		const key = messageKey(message);
		if (key ? received.has(key) : receivedObjects.has(message)) return;
		if (key) received.add(key);
		else receivedObjects.add(message);
		// Observers never change the message or add a reply, even if a hook prints a gate verdict.
		await dispatch(ctx, "PostMessageReceive", messageNames(message), () => ({ message }), signal).catch(
			(error: unknown) => {
				if (!signal.aborted) reportFailure(ctx, "PostMessageReceive", error);
			},
		);
	};

	pi.on("context", async (event, ctx) => {
		const signal = messageAbort.signal;
		for (const message of event.messages) {
			for (const envelope of receivedMessages(message)) {
				if (signal.aborted) return undefined;
				await messageReceive(envelope, ctx);
			}
		}
		return undefined;
	});

	return { messageSend, messageReceive };
}

/** Notification observers outlive the foreground turn, but never their session. */
function notificationHook(
	pi: ExtensionAPI,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): HooksView["notification"] {
	let controller = new AbortController();
	let closed = false;
	const active = new Set<Promise<void>>();
	const stop = async () => {
		closed = true;
		controller.abort();
		await Promise.allSettled([...active]);
	};
	pi.on("session_shutdown", stop);
	pi.on("session_start", async () => {
		await stop();
		controller = new AbortController();
		closed = false;
	});
	return (notice, ctx) => {
		if (closed) return;
		const input = {
			message: notice.message,
			...(notice.title ? { title: notice.title } : {}),
			notification_type: notice.type,
		};
		const task = dispatch(ctx, "Notification", [notice.type], () => input, controller.signal)
			.then(
				() => undefined,
				(error: unknown) => reportFailure(ctx, "Notification", error),
			)
			.finally(() => active.delete(task));
		active.add(task);
	};
}

/**
 * Stop: when the agent would settle after a completed run, a blocking hook sends it on with the reason (Claude
 * Code's loop guards: `stop_hook_active` while continuing, at most 8 continuations in a row unless a tool runs).
 */
function registerSubagentHooks(
	pi: ExtensionAPI,
	session: HookSession,
	dispatch: Dispatch,
	env: NodeJS.ProcessEnv,
	metadata: (() => HookHostMetadata) | undefined,
): void {
	let codexStart = false;
	let stopContinues = 0;
	const agentType = metadata?.().agentType || "general";
	const identity = (ctx: ExtensionContext, protocol: "claude" | "codex", stop: boolean): Record<string, unknown> => ({
		agent_id:
			protocol === "codex"
				? ctx.sessionManager.getSessionId()
				: metadata?.().agentName || ctx.sessionManager.getSessionId(),
		agent_type: agentType,
		...(protocol === "claude"
			? {
					session_id: env[PARENT_SESSION_ENV],
					transcript_path: env[PARENT_TRANSCRIPT_ENV] || "",
				}
			: {}),
		...(stop
			? {
					transcript_path: env[PARENT_TRANSCRIPT_ENV] || (protocol === "codex" ? null : ""),
					agent_transcript_path: ctx.sessionManager.getSessionFile() ?? (protocol === "codex" ? null : ""),
				}
			: {}),
	});
	const ready = (ctx: ExtensionContext, protocol: "claude" | "codex"): boolean => {
		const valid =
			!!metadata?.().permissionMode &&
			!!ctx.model &&
			(protocol !== "codex" || !!ctx.getTurnId?.()) &&
			(protocol !== "claude" || !!env[PARENT_SESSION_ENV]);
		if (!valid) {
			const diagnostic = `Skipping ${protocol} subagent hooks: live permission, model, turn or parent identity is unavailable`;
			if (!session.errors.includes(diagnostic)) {
				session.errors.push(diagnostic);
				if (ctx.hasUI) notify(ctx.ui, diagnostic, "warning");
				else process.stderr.write(`${diagnostic}\n`);
			}
		}
		return valid;
	};
	pi.on("session_start", async (event) => {
		codexStart = event.reason === "startup" || event.reason === "fork";
		stopContinues = 0;
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		stopContinues = 0;
		const contexts: string[] = [];
		const contextKeys: string[] = [];
		for (const protocol of ["claude", "codex"] as const) {
			if (!commandsFor(session.config, "SubagentStart", [agentType]).some((hook) => hook.protocol === protocol))
				continue;
			if (protocol === "codex" && !codexStart) continue;
			if (protocol === "codex") codexStart = false;
			if (!ready(ctx, protocol)) continue;
			const verdict = await dispatch(
				ctx,
				"SubagentStart",
				[agentType],
				() => identity(ctx, protocol, false),
				ctx.signal,
				protocol,
			);
			if (ctx.signal?.aborted) return;
			if (!verdict.context) continue;
			const key = sha256(`${protocol}\0${verdict.context}`);
			const present =
				protocol === "claude" &&
				ctx.sessionManager
					.buildSessionProjection()
					.messages.some(
						(message) =>
							message.role === "custom" &&
							message.customType === CONTEXT_TYPE &&
							isRecord(message.details) &&
							Array.isArray(message.details.subagentStartKeys) &&
							message.details.subagentStartKeys.includes(key),
					);
			if (!present) {
				contexts.push(capContext(`Context from ${protocol} SubagentStart hooks:\n${verdict.context}`));
				contextKeys.push(key);
			}
		}
		if (contexts.length)
			return {
				message: {
					customType: CONTEXT_TYPE,
					content: contexts.join("\n\n"),
					display: false,
					details: { subagentStartKeys: contextKeys },
				},
			};
	});
	pi.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) stopContinues = 0;
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const last = [...event.context.llmMessages].reverse().find((message) => message.role === "assistant");
		const verdicts: HookVerdict[] = [
			await dispatch(
				ctx,
				"Stop",
				[],
				() => ({
					stop_hook_active: stopContinues > 0,
					last_assistant_message: last ? contentText(last.content) : "",
				}),
				ctx.signal,
				"octocode",
			),
		];
		for (const protocol of ["claude", "codex"] as const) {
			if (
				!commandsFor(session.config, "SubagentStop", [agentType]).some((hook) => hook.protocol === protocol) ||
				!ready(ctx, protocol)
			)
				continue;
			verdicts.push(
				await dispatch(
					ctx,
					"SubagentStop",
					[agentType],
					() => ({
						...identity(ctx, protocol, true),
						stop_hook_active: stopContinues > 0,
						last_assistant_message: last ? contentText(last.content) : "",
					}),
					ctx.signal,
					protocol,
				),
			);
		}
		if (ctx.signal?.aborted || verdicts.some((verdict) => verdict.stop)) return;
		const feedback = verdicts
			.flatMap((verdict) => [verdict.block, verdict.continueReason])
			.filter(Boolean)
			.join("\n\n");
		if (!feedback || stopContinues >= STOP_CONTINUE_CAP) return;
		stopContinues += 1;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: STOP_TYPE,
					content: `${verdicts.slice(1).some((verdict) => verdict.block || verdict.continueReason) ? "SubagentStop hook feedback:\n" : STOP_PREFIX}${feedback}`,
					display: true,
				},
			],
			continue: true,
		};
	});
}

function registerStopHook(pi: ExtensionAPI, session: HookSession, dispatch: Dispatch, child = false): void {
	/** Stop-hook continuations in a row (reset by a prompt or a tool call). */
	let stopContinues = 0;
	pi.on("before_agent_start", async () => {
		stopContinues = 0;
		return undefined;
	});
	pi.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) stopContinues = 0;
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		const last = [...event.context.llmMessages].reverse().find((message) => message.role === "assistant");
		if (event.outcome === "error") {
			const details = last?.errorMessage;
			await dispatch(
				ctx,
				"StopFailure",
				["unknown"],
				() => ({
					error: "unknown",
					...(details ? { error_details: details, last_assistant_message: details } : {}),
				}),
				ctx.signal,
				"claude",
			);
			return undefined;
		}
		if (child) return undefined;
		const stops = commandsFor(session.config, "Stop", []);
		if (event.outcome !== "completed" || stops.length === 0) return undefined;
		// Octocode removed its working indicator at `agent_end`; the footer status shows the hooks still running.
		const verdict = await withStatus(ctx, hooksLabel("Stop", stops), () =>
			dispatch(ctx, "Stop", [], () => ({
				stop_hook_active: stopContinues > 0,
				last_assistant_message: last ? contentText(last.content) : "",
			})),
		);
		const feedback = [verdict.block, verdict.continueReason].filter(Boolean).join("\n\n");
		if (!feedback || stopContinues >= STOP_CONTINUE_CAP) return undefined;
		stopContinues += 1;
		// Octocode replaces the boundary's entries with a handler's: keep what earlier handlers proposed.
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: STOP_TYPE,
					content: `${STOP_PREFIX}${feedback}`,
					display: true,
				},
			],
			continue: true,
		};
	});
}

/** PostToolUse: feedback from the hooks is appended to the tool result the model reads. */
function registerPostToolUseHook(
	pi: ExtensionAPI,
	dispatch: Dispatch,
	session: HookSession,
	patches: Map<string, string>,
): void {
	pi.on("tool_result", async (event, ctx) => {
		const outcomes =
			event.toolName === "file" && isRecord(event.details) && Array.isArray(event.details.outcomes)
				? event.details.outcomes
				: undefined;
		const patch = patches.get(event.toolCallId);
		patches.delete(event.toolCallId);
		const feedback: string[] = [];
		let replaceResult = false;
		let rejectNested = false;
		for (const protocol of ["octocode", "claude", "codex"] as const) {
			if (event.isError && protocol !== "claude") continue;
			// Codex's patch observer only follows a fully successful patch, not a partially applied native batch.
			if (protocol === "codex" && outcomes?.some((outcome) => !isRecord(outcome) || outcome.ok !== true)) continue;
			const hookEvent = event.isError && protocol === "claude" ? "PostToolUseFailure" : "PostToolUse";
			if (
				protocol !== "codex" &&
				event.toolName === "file" &&
				typeof event.input.patch === "string" &&
				parsePatch(event.input.patch).hunks.some((h) => h.kind === "update")
			) {
				if (
					commandsFor(session.config, hookEvent, ["file", "Edit", "MultiEdit", "Write", "Delete"]).some(
						(h) => (h.protocol ?? "octocode") === protocol,
					)
				)
					feedback.push(
						`${protocol} ${hookEvent} hook unavailable: canonical Update/Move patches have no lossless per-query projection`,
					);
				continue;
			}
			const codexFile = protocol === "codex" && event.toolName === "file";
			if (
				codexFile &&
				!patch &&
				commandsFor(session.config, "PostToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex")
			) {
				feedback.push(
					"Codex apply_patch PostToolUse hook unavailable: this file call has no lossless pre-call patch projection",
				);
			}
			const calls = codexFile
				? patch
					? [{ names: CODEX_PATCH_NAMES, tool_name: "apply_patch", tool_input: { command: patch } }]
					: []
				: hookCalls(event.toolName, event.input, ctx.cwd);
			for (const [index, call] of calls.entries()) {
				// A denied or failed file query cannot be reported as a successful mutation.
				if (!codexFile && outcomes && (!isRecord(outcomes[index]) || outcomes[index].ok !== true)) continue;
				const verdict = await dispatch(
					ctx,
					hookEvent,
					call.names,
					() => ({
						tool_use_id: event.toolCallId,
						tool_name: call.tool_name,
						pi_tool_name: event.toolName,
						tool_input: call.tool_input,
						...(hookEvent === "PostToolUseFailure"
							? { error: contentText(event.content), ...(ctx.signal?.aborted ? { is_interrupt: true } : {}) }
							: { tool_response: contentText(event.content) }),
					}),
					ctx.signal,
					protocol,
				);
				feedback.push(...[verdict.block, verdict.context].filter((text): text is string => Boolean(text)));
				replaceResult ||= verdict.replaceResult === true;
				rejectNested ||= verdict.rejectNested === true;
			}
		}
		return feedback.length > 0
			? {
					content: [
						...(replaceResult ? [] : event.content),
						{
							type: "text" as const,
							text: `\n[${event.isError ? "PostToolUseFailure/PostToolUse" : "PostToolUse"} hook] ${capContext(feedback.join("\n\n"))}`,
						},
					],
					...(replaceResult ? { details: null } : {}),
					...(rejectNested && event.parentToolCallId ? { isError: true } : {}),
				}
			: undefined;
	});
}

/** Native PreCompact remains observational; source-profile vetoes cancel through the core owner. */
function registerPreCompactHook(pi: ExtensionAPI, dispatch: Dispatch): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const verdict = await dispatch(
			ctx,
			"PreCompact",
			[trigger],
			() => ({
				trigger,
				custom_instructions: "",
			}),
			event.signal,
		);
		return verdict.cancelCompaction && !event.signal?.aborted ? { cancel: true } : undefined;
	});
}

function registerSessionEndHook(
	pi: ExtensionAPI,
	session: HookSession,
	dispatch: Dispatch,
	env: NodeJS.ProcessEnv,
): void {
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") return;
		const run = async (protocol: "claude" | "codex", reason: string) => {
			const configuredBudget = Math.min(
				60_000,
				Math.max(
					1500,
					...session.config.SessionEnd.flatMap((group) =>
						group.hooks.filter((hook) => hook.protocol === "claude" && !hook.plugin).map((hook) => hook.timeoutMs),
					),
				),
			);
			const budget = protocol === "codex" ? 3000 : (claudeSessionEndOverride(env) ?? configuredBudget);
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), budget);
			try {
				await dispatch(ctx, "SessionEnd", [reason], () => ({ reason }), abort.signal, protocol);
			} finally {
				clearTimeout(timer);
			}
		};
		await Promise.all([
			run("claude", event.reason === "new" ? "clear" : event.reason === "resume" ? "resume" : "other"),
			...(event.reason === "quit" && !envFlag(env, SUBAGENT_ENV) ? [run("codex", "other")] : []),
		]);
	});
}

function registerPostCompactHook(pi: ExtensionAPI, dispatch: Dispatch): void {
	pi.on("session_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const verdict = await dispatch(ctx, "PostCompact", [trigger], () => ({
			trigger,
			compact_summary: event.compactionEntry.summary,
		}));
		if (verdict.stop) ctx.abort("internal");
		if (verdict.context && !verdict.stop && !ctx.signal?.aborted) {
			await pi.sendMessage(
				{
					customType: CONTEXT_TYPE,
					content: capContext(`Context from PostCompact hooks:\n${verdict.context}`),
					display: false,
				},
				{ triggerTurn: false },
			);
		}
	});
}

function registerPostToolBatchHook(pi: ExtensionAPI, dispatch: Dispatch): void {
	pi.on("turn_end", async (event, ctx) => {
		if (ctx.signal?.aborted || event.toolResults.length === 0 || event.message.role !== "assistant") return;
		const calls = event.message.content.filter((content) => content.type === "toolCall");
		const verdict = await dispatch(
			ctx,
			"PostToolBatch",
			[],
			() => ({
				tool_calls: calls.map((call) => {
					const projected = call.name === "file" ? undefined : hookCalls(call.name, call.arguments, ctx.cwd)[0];
					return {
						tool_use_id: call.id,
						tool_name: projected?.tool_name ?? call.name,
						tool_input: projected?.tool_input ?? call.arguments,
						tool_response: event.toolResults.find((result) => result.toolCallId === call.id)?.content ?? [],
					};
				}),
			}),
			ctx.signal,
			"claude",
		);
		if (ctx.signal?.aborted) return;
		const feedback = verdict.block ?? verdict.context;
		if (!feedback) return;
		if (verdict.block) ctx.abort("internal");
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: CONTEXT_TYPE,
					content: capContext(`PostToolBatch hook feedback:\n${feedback}`),
					display: Boolean(verdict.block),
				},
			],
		};
	});
}

function registerPromptHook(pi: ExtensionAPI, dispatch: Dispatch): void {
	pi.on("user_input", async (event, ctx) => {
		const verdict = await dispatch(ctx, "UserPromptSubmit", [], () => ({ prompt: event.text }), ctx.signal, "codex");
		if (verdict.block && ctx.hasUI) notify(ctx.ui, `Blocked by a UserPromptSubmit hook: ${verdict.block}`, "warning");
		return {
			block: !!verdict.block,
			additionalContext: verdict.context
				? [capContext(`Context from UserPromptSubmit hooks:\n${verdict.context}`)]
				: [],
		};
	});
	pi.on("input", async (event, ctx) => {
		const verdict = await dispatch(ctx, "UserPromptSubmit", [], () => ({ prompt: event.text }), ctx.signal, [
			"octocode",
			"claude",
		]);
		if (ctx.signal?.aborted) return { action: "handled" };
		if (verdict.block) {
			if (ctx.hasUI) notify(ctx.ui, `Blocked by a UserPromptSubmit hook: ${verdict.block}`, "warning");
			return { action: "handled" };
		}
		if (verdict.context) {
			await pi.sendMessage(
				{
					customType: CONTEXT_TYPE,
					content: capContext(`Context from UserPromptSubmit hooks:\n${verdict.context}`),
					display: false,
				},
				{ triggerTurn: false },
			);
		}
		return { action: "continue" };
	});
}

function registerInterruptHook(
	pi: ExtensionAPI,
	session: HookSession,
	dispatch: Dispatch,
	metadata: (() => HookHostMetadata) | undefined,
): void {
	pi.on("agent_interrupted", async (event, ctx) => {
		if (!commandsFor(session.config, "Interrupt", []).length) return;
		if (!event.model || !metadata?.().permissionMode) {
			const diagnostic = "Skipping Codex Interrupt hook: live model or permission metadata is unavailable";
			if (!session.errors.includes(diagnostic)) {
				session.errors.push(diagnostic);
				if (ctx.hasUI) notify(ctx.ui, diagnostic, "warning");
				else process.stderr.write(`${diagnostic}\n`);
			}
			return;
		}
		const interrupted = {
			...ctx,
			cwd: event.cwd,
			model: event.model,
			getTurnId: () => event.turnId,
		};
		await dispatch(
			interrupted,
			"Interrupt",
			[],
			() => ({
				session_id: event.sessionId,
				transcript_path: event.transcriptPath ?? null,
			}),
			AbortSignal.timeout(3100),
			"codex",
		);
	});
}

export function registerHooks(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	home?: string,
	onFailure?: HookFailureSink,
	metadata?: () => HookHostMetadata,
): HooksView {
	const session: HookSession = { config: emptyHooks(), errors: [], root: undefined };
	const enabled = hooksEnabled(env);
	const timings = new Map<string, HookTiming>();
	const view: HooksView = {
		summary: () => (enabled ? `on, ${hookCount(session.config)} commands` : `off (${HOOKS_ENV}=1 to enable)`),
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
	const runner = createDispatcher(pi, session, timings, onFailure, background, child, metadata);
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
		const permissionUpdates: import("../shared/permission-updates.ts").SourcePermissionUpdate[] = [];
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

/** `⚑ Stop hook`, then the hook's feedback: untrusted text, sanitized and previewed by resultBlock, never drawn as Markdown. */
function registerStopRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(STOP_TYPE, (message, { expanded, outputPad }, theme) => {
		const text = contentText(message.content);
		const box = new Box(outputPad ?? 1, 0);
		box.addChild(
			new Text(
				`${theme.fg("warning", "⚑")} ${theme.fg("toolTitle", theme.bold("Stop hook"))} ${theme.fg("dim", "· continuing")}`,
				0,
				0,
			),
		);
		box.addChild(
			resultBlock(
				theme,
				{ expanded },
				{ summary: "", body: text.startsWith(STOP_PREFIX) ? text.slice(STOP_PREFIX.length) : text, error: false },
			),
		);
		return box;
	});
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
