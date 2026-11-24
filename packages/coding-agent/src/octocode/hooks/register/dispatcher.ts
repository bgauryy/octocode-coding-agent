import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { notify, say } from "../../shared/commands.ts";
import { formatDuration } from "../../shared/format.ts";
import { repoKey } from "../../../utils/git-repository.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { hookIdentity } from "../config/calls.ts";
import type { HookEvent } from "../catalog.ts";
import type { HookHandler, HookVerdict } from "../contracts.ts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { clipText, stringOrEmpty } from "../../shared/util.ts";
import type { registerBackgroundHooks } from "../background.ts";
import { limitCodexContext } from "../context-limit.ts";
import { hookLabel } from "../config.ts";
import { httpDecisionNote, labelHttpVerdict } from "../http-origin.ts";
import { createPromptEvaluator, interpretPromptHook } from "../prompt.ts";
import { boundMcpHookCaller } from "../mcp-gate.ts";
import { hookPayload } from "../profiles.ts";
import { combineVerdicts, decisionOnly } from "../verdicts.ts";
import { type HookClock, REAL_HOOK_CLOCK } from "./clock.ts";
import type { PolicyEnv } from "./event-policy.ts";
import { policyFor } from "./policies.ts";
import { type MatchedHookRun, subscribedDispatch } from "./subscribed.ts";
import { capContext, CLAUDE_HOOK_CONTEXT_MAX, claudeJsonRun, failureOf, interpret, runHook } from "../runner.ts";
import {
	type Dispatch,
	type HookFailureSink,
	type HookHostMetadata,
	type HookSession,
	type HookTiming,
	type ReportFailure,
	SLOW_HOOK_MS,
} from "./types.ts";

export interface DispatcherOptions {
	api: FeatureSetup;
	session: HookSession;
	timings: Map<string, HookTiming>;
	onFailure?: HookFailureSink;
	background: ReturnType<typeof registerBackgroundHooks>;
	child: boolean;
	metadata?: () => HookHostMetadata;
	paused?: () => boolean;
	/** A subagent's parent session id: Codex hooks in a child receive it as `session_id`. */
	parentSession?: string;
	/** A subagent in the `decisions` hook mode: only a hook's refusal or ask takes effect (`decisionOnly`), and a background hook, which can decide nothing, does not start. */
	decisionsOnly?: boolean;
	/** Times each hook run for the slow-hook notice and the report (the wall clock by default). */
	clock?: HookClock;
}

/**
 * The shared hook runner: `dispatch` runs the hooks of one event, `reportFailure` says once per event that a dispatch
 * itself failed. It runs handlers and times them; what an event adds is its `EventPolicy` (`policies.ts`).
 */
export function createDispatcher(options: DispatcherOptions): {
	dispatch: Dispatch;
	reportFailure: ReportFailure;
	stop(): Promise<void>;
} {
	const { api, session, timings, onFailure, background, child, metadata, paused, parentSession } = options;
	const decisionsOnly = options.decisionsOnly ?? false;
	const clock = options.clock ?? REAL_HOOK_CLOCK;
	let controller = new AbortController();
	const active = new Set<Promise<HookVerdict>>();
	/** Commands already reported as slow, so each is reported once per hook registration (a session host). */
	const slowWarned = new Set<string>();
	const timeHook = async (
		ctx: FeatureContext,
		event: HookEvent,
		hook: HookHandler,
		run: () => ReturnType<typeof runHook>,
	): ReturnType<typeof runHook> => {
		const started = clock.now();
		const result = await run();
		const ms = clock.now() - started;
		const key = `${event}\0${hookIdentity(hook)}`;
		const timing = timings.get(key) ?? { runs: 0, totalMs: 0, maxMs: 0, failed: 0 };
		const failed = failureOf(hook, claudeJsonRun(hook, result), ctx.signal?.aborted === true) !== undefined;
		timings.set(key, {
			runs: timing.runs + 1,
			totalMs: timing.totalMs + ms,
			maxMs: Math.max(timing.maxMs, ms),
			failed: timing.failed + (failed ? 1 : 0),
		});
		const policy = policyFor(event);
		if (
			ms >= SLOW_HOOK_MS &&
			!slowWarned.has(key) &&
			ctx.hasUI &&
			!((hook.type === undefined || hook.type === "command") && (hook.async || hook.asyncRewake)) &&
			!policy.quietSlow
		) {
			slowWarned.add(key);
			notify(
				ctx.ui,
				`Slow ${event} hook (${formatDuration(ms)})${policy.slowNote ?? ""}. ${clipText(hookLabel(hook), 80)}`,
				"warning",
			);
		}
		return result;
	};

	/** Hooks already warned about for a failure, so each is shown once per hook registration (every failure is audited). */
	const failureWarned = new Set<string>();
	const firstTime = (key: string): boolean => {
		if (failureWarned.has(key)) return false;
		failureWarned.add(key);
		return true;
	};

	/**
	 * Runs the hooks matching `names` in parallel, as the hook protocol specifies; the event's policy decides how their
	 * verdicts combine (any block blocks, in config order). Most tool calls match no hook, so the input (which may join a
	 * large tool result) is built only when one does.
	 */
	const dispatchImpl: MatchedHookRun = async (ctx, event, input, signal, protocol, hooks) => {
		if (signal?.aborted) return {};
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
		// Codex: "Subagent hooks use the parent session id" (hooks reference, Common input fields).
		const payloadFor = (hook: HookHandler): Record<string, unknown> => {
			const protocolName = hook.protocol ?? "octocode";
			const projected = hookPayload(protocolName, payload, dispatchMetadata);
			return protocolName === "codex" && parentSession ? { ...projected, session_id: parentSession } : projected;
		};
		const policy = policyFor(event);
		const guarded = policy.guarded?.(protocol) === true;
		const policyEnv = (hook: HookHandler): PolicyEnv => ({ event, ctx, hook, payload, onFailure, firstTime });
		const runOne = async (hook: HookHandler, signal: AbortSignal | undefined): Promise<HookVerdict> => {
			if (hook.configurationError) {
				const refused = policy.configurationError?.(policyEnv(hook), hook.configurationError);
				if (refused) return refused;
			}
			if (
				(hook.type === undefined || hook.type === "command") &&
				hook.protocol !== "octocode" &&
				!policy.inline &&
				(hook.async || hook.asyncRewake)
			) {
				if (!signal?.aborted && !decisionsOnly)
					background.start(
						hook,
						event,
						(backgroundSignal) =>
							timeHook(ctx, event, hook, () => runHook(hook, payloadFor(hook), ctx.cwd, env, backgroundSignal)),
						(message) => say(ctx, message, "warning"),
					);
				return {};
			}
			const run = claudeJsonRun(
				hook,
				await timeHook(ctx, event, hook, () =>
					runHook(
						hook,
						payloadFor(hook),
						ctx.cwd,
						env,
						signal,
						boundMcpHookCaller(api.channels, ctx, event),
						hook.type === "prompt" ? createPromptEvaluator(ctx) : undefined,
					),
				),
			);
			if (guarded && signal?.aborted) return {};
			const answered = labelHttpVerdict(
				hook,
				hook.type === "prompt"
					? (policy.prompt?.(policyEnv(hook), run) ?? interpretPromptHook(event, run, hook.continueOnBlock))
					: interpret(event, run, hook.protocol),
			);
			const verdict = decisionsOnly ? decisionOnly(answered) : answered;
			const decision = signal?.aborted ? undefined : httpDecisionNote(hook, verdict);
			if (decision) onFailure?.([`${event} ${stringOrEmpty(payload.tool_name)}`.trim()], decision, true);
			if (verdict.systemMessage) say(ctx, verdict.systemMessage, "warning");
			if (hook.protocol === "codex" && verdict.context)
				verdict.context = limitCodexContext(verdict.context, hook.additionalContextLimit);
			if (hook.protocol === "claude" && verdict.context)
				verdict.context = capContext(verdict.context, CLAUDE_HOOK_CONTEXT_MAX);
			if (hook.protocol === "claude" && verdict.systemMessage)
				verdict.systemMessage = capContext(verdict.systemMessage, CLAUDE_HOOK_CONTEXT_MAX);
			// Failure text can hold what a server or a script printed, so it is redacted before it is shown or audited.
			const reported = !signal?.aborted ? (verdict.error ?? failureOf(hook, run, false)) : undefined;
			const failure = reported === undefined ? undefined : redactSecrets(reported);
			return policy.settle?.(policyEnv(hook), verdict, failure) ?? verdict;
		};
		const running = hooks.map(async (hook): Promise<HookVerdict> => {
			try {
				return await runOne(hook, signal);
			} catch (error) {
				if (!guarded || !policy.crash) throw error;
				if (signal?.aborted) return {};
				return policy.crash(policyEnv(hook), errorMessage(error));
			}
		});
		const verdicts = await Promise.all(running);
		const decided = policy.decide?.(verdicts, signal);
		if (decided) return decided;
		const halted = verdicts.find((verdict) => verdict.haltTurn);
		if (halted) {
			say(ctx, halted.block ?? halted.context ?? "Stopped by a hook", "warning");
			ctx.abort("internal");
		}
		return combineVerdicts(verdicts, policy.combine);
	};

	/** A dispatch that itself failed (not a hook's verdict): reported once per event per hook registration, with a UI. */
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

	const run = subscribedDispatch(api, session, dispatchImpl);
	const dispatch: Dispatch = async (ctx, event, names, input, requested, protocol, hookFilter) => {
		const signal = requested ?? ctx.signal;
		if (paused?.()) return {};
		const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		const work = run(ctx, event, names, input, combined, protocol, hookFilter);
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
