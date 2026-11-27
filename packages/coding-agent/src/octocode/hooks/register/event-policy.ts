import type { FeatureContext } from "../../../core/features/index.ts";
import { notify, say } from "../../shared/commands.ts";
import { clipText, firstLine, optionalString } from "../../shared/util.ts";
import { redactSecrets, visibleControls } from "@octocodeai/octocode-common/sanitize";
import { hookIdentity } from "../config/calls.ts";
import { hookLabel } from "../config.ts";
import type { HookEvent, HookProtocol } from "../catalog.ts";
import type { HookHandler, HookRun, HookVerdict } from "../contracts.ts";
import type { CombineOptions } from "../verdicts.ts";
import type { HookFailureSink } from "./types.ts";

/** What a policy sees of one hook run: the event, the hook, the payload it received and the dispatcher's shared failure sinks. */
export interface PolicyEnv {
	event: HookEvent;
	ctx: FeatureContext;
	hook: HookHandler;
	payload: Record<string, unknown>;
	onFailure?: HookFailureSink;
	/** True the first time `key` is asked for: warnings show once per hook registration. */
	firstTime(key: string): boolean;
}

/**
 * The rules one event adds to the dispatcher, which only runs the handlers and times them: how a hook's configuration
 * error, a prompt hook's answer, a crash and a failure are read, and how the verdicts of the event combine. An event
 * without a policy uses `defaultPolicy`. How the input is built stays with the code that dispatches the event.
 */
export interface EventPolicy {
	/** Whether every hook of the event finishes and a crash is that hook's own verdict. */
	guarded?(protocol: HookProtocol | readonly HookProtocol[] | undefined): boolean;
	/** The verdict of a hook that crashed in a `guarded` event. */
	crash?(env: PolicyEnv, message: string): HookVerdict;
	/** The verdict of a hook whose configuration is invalid; undefined runs the hook anyway. */
	configurationError?(env: PolicyEnv, message: string): HookVerdict | undefined;
	/** A prompt hook's answer as a verdict. */
	prompt?(env: PolicyEnv, run: HookRun): HookVerdict;
	/** The final verdict of a hook run, given its failure (undefined when it answered): warn, audit or turn the failure into a block. */
	settle?(env: PolicyEnv, verdict: HookVerdict, failure: string | undefined): HookVerdict;
	/** An answer that replaces the combination of all verdicts, or undefined to combine them. */
	decide?(verdicts: readonly HookVerdict[], signal: AbortSignal | undefined): HookVerdict | undefined;
	/** How the combination differs from the common one. */
	combine?: CombineOptions;
	/** Appended to the slow-hook notice. */
	slowNote?: string;
	/** No slow-hook notice: the hooks of this event run in the background anyway. */
	quietSlow?: true;
	/** `async` hooks of this event run in line: nothing outlives it. */
	inline?: true;
}

/** Says once per hook that it failed. */
export function warnFailure(env: PolicyEnv, failure: string): void {
	const key = `${env.event}\0${hookIdentity(env.hook)}`;
	if (!env.firstTime(key)) return;
	say(
		env.ctx,
		`${env.event} hook ${failure}: ${clipText(redactSecrets(visibleControls(hookLabel(env.hook))), 80)}`,
		"warning",
	);
}

/** Hooks fail open: a failure is shown when the user can see it. */
export const defaultPolicy: EventPolicy = {
	settle(env, verdict, failure) {
		if (failure && env.ctx.hasUI) warnFailure(env, failure);
		return verdict;
	},
};

/** An event whose hook may block its action when it fails: with `onFailure: "block"` a failure blocks. */
export function blockOnFailure(env: PolicyEnv, verdict: HookVerdict, failure: string | undefined): HookVerdict {
	const settled = defaultPolicy.settle?.(env, verdict, failure) ?? verdict;
	return failure && env.hook.onFailure === "block"
		? { ...settled, block: `${env.event} hook ${failure}; onFailure: "block"` }
		: settled;
}

/**
 * The policy of an event that gates an action (a tool call, a message send). A hook that gave no answer lets the action
 * go ahead unless it is `failClosed`; either way the user sees a warning (once per hook, with a UI) and the audit records
 * it. `describe` names what the action was.
 */
export function gatePolicy(
	event: "PreToolUse" | "PreMessageSend",
	noun: "tool" | "message",
	describe: (payload: Record<string, unknown>) => string,
): EventPolicy {
	const failed = (env: PolicyEnv, failure: string, target: string): string | undefined => {
		const { hook, ctx } = env;
		const failurePolicy = hook.onFailure === "block" ? 'onFailure: "block"' : "failClosed";
		const closed = hook.failClosed === true || hook.onFailure === "block";
		const command = clipText(firstLine(redactSecrets(visibleControls(hookLabel(hook)))), 80);
		env.onFailure?.(
			[`${event} hook ${failure}: ${command}`, `${noun}: ${target}`],
			closed ? `hook failed; ${failurePolicy} denied the call` : "hook failed; hooks fail open, the call was allowed",
			!closed,
		);
		if (ctx.hasUI && env.firstTime(`${event}\0${hookIdentity(hook)}`))
			notify(
				ctx.ui,
				`${event} hook ${failure}: ${command}. ${closed ? `The call was denied (${failurePolicy}).` : 'The call was allowed (hooks fail open); set "failClosed": true on the hook to deny instead.'}`,
				"warning",
			);
		return closed ? `${event} hook ${failure} and is set to ${failurePolicy}: ${command}` : undefined;
	};
	return {
		configurationError: (env, message) => ({
			block: failed(env, message, optionalString(env.payload.tool_name) ?? "message"),
		}),
		settle(env, verdict, failure) {
			const block = failure ? failed(env, failure, describe(env.payload)) : undefined;
			return block ? { ...verdict, block } : verdict;
		},
		...(event === "PreToolUse" ? { slowNote: ": every tool call in a batch waits for it" } : {}),
	};
}
