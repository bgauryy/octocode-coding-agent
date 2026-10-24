import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/index.ts";
import { notify, say } from "../../shared/commands.ts";
import { formatDuration } from "../../shared/format.ts";
import { repoKey } from "../../shared/home/repo.ts";
import { errorMessage, isRecord } from "../../../utils/guards.ts";
import { commandsFor, hookIdentity } from "../config/calls.ts";
import type { HookHandler, HookEvent, HookVerdict } from "../contracts.ts";
import { redactSecrets, visibleControls } from "../../shared/sanitize.ts";
import { clipText, firstLine, optionalString, stringOrEmpty } from "../../shared/util.ts";
import type { registerBackgroundHooks } from "../background.ts";
import { limitCodexContext } from "../context-limit.ts";
import { hookLabel } from "../config.ts";
import { createPromptEvaluator, interpretPromptHook } from "../prompt.ts";
import { boundMcpHookCaller } from "../mcp-gate.ts";
import { hookPayload } from "../profiles.ts";
import { capContext, failureOf, interpret, runHook } from "../runner.ts";
import {
	type Dispatch,
	type HookFailureSink,
	type HookHostMetadata,
	type HookSession,
	type HookTiming,
	type ReportFailure,
	SLOW_HOOK_MS,
} from "./types.ts";

/** The shared hook runner: `dispatch` runs the hooks of one event, `reportFailure` says once per event that a dispatch itself failed. */
export function createDispatcher(
	pi: ExtensionAPI,
	session: HookSession,
	timings: Map<string, HookTiming>,
	onFailure: HookFailureSink | undefined,
	background: ReturnType<typeof registerBackgroundHooks> | undefined,
	child: boolean,
	metadata: (() => HookHostMetadata) | undefined,
	paused?: () => boolean,
): { dispatch: Dispatch; reportFailure: ReportFailure; stop(): Promise<void> } {
	let controller = new AbortController();
	const active = new Set<Promise<HookVerdict>>();
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
	const dispatchImpl: Dispatch = async (ctx, event, names, input, signal = ctx.signal, protocol) => {
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
					block: hookFailed(ctx, hook, hook.configurationError, optionalString(payload.tool_name) ?? "message", event),
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
					boundMcpHookCaller(pi.events, ctx, event),
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
			const target =
				gate === "PreMessageSend"
					? `${stringOrEmpty(message.from)} -> ${stringOrEmpty(message.to)}`
					: stringOrEmpty(payload.tool_name);
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

	const dispatch: Dispatch = async (ctx, event, names, input, signal = ctx.signal, protocol) => {
		if (paused?.()) return {};
		const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		const work = dispatchImpl(ctx, event, names, input, combined, protocol);
		active.add(work);
		try {
			return await work;
		} finally {
			active.delete(work);
		}
	};
	return {
		dispatch,
		reportFailure,
		async stop() {
			controller.abort();
			await Promise.allSettled(active);
			controller = new AbortController();
		},
	};
}
