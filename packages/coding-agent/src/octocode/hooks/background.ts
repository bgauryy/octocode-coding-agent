import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { parseJson } from "../shared/util.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { HookEvent } from "./catalog.ts";
import type { HookCommand, HookRun } from "./contracts.ts";
import { capContext, failureOf, interpret } from "./runner.ts";
import { sendHookFeedback } from "../wake/senders.ts";
import { validateCodexOutput } from "./codex-output.ts";
import { limitCodexContext } from "./context-limit.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";

function codexContext(event: HookEvent, stdout: string, warn: (message: string) => void): string | undefined {
	const value = parseJson(stdout);
	if (!isRecord(value)) {
		if (event === "SessionStart" || event === "UserPromptSubmit") return visibleControls(stdout.trim()) || undefined;
		if (event === "PreToolUse" && stdout.trim()) warn("Codex PreToolUse output must be a JSON object");
		return;
	}
	const error = validateCodexOutput(event, value);
	if (error) {
		warn(error);
		return;
	}
	if (typeof value.systemMessage === "string" && value.systemMessage.trim()) warn(value.systemMessage);
	const specific = asRecord(value.hookSpecificOutput);
	return typeof specific.additionalContext === "string"
		? visibleControls(specific.additionalContext.trim()) || undefined
		: undefined;
}

function backgroundContext(stdout: string): string | undefined {
	const whole = parseJson(stdout);
	const value = isRecord(whole) ? whole : stdout.split(/\r?\n/).map(parseJson).findLast(isRecord);
	if (!isRecord(value)) return;
	const specific = asRecord(value.hookSpecificOutput);
	const parts = [value.systemMessage, specific.additionalContext].filter(
		(part): part is string => typeof part === "string" && Boolean(part.trim()),
	);
	return parts.length ? visibleControls(parts.join("\n\n")) : undefined;
}

/** Own background processes and pending context for one live session, independently of a foreground turn. */
export function registerBackgroundHooks(api: FeatureSetup) {
	let controller = new AbortController();
	let closed = false;
	const active = new Set<Promise<void>>();
	let codexRunning = 0;
	const codexQueue: Array<() => void> = [];
	let pending: string[] = [];
	const reset = async (shutdown: boolean) => {
		closed = true;
		codexQueue.length = 0;
		controller.abort();
		pending = [];
		await Promise.allSettled(active);
		if (!shutdown) {
			controller = new AbortController();
			closed = false;
		}
	};
	api.bus.on("session_start", async () => reset(false));
	api.bus.on("session_shutdown", async () => reset(true));
	const takeContext = () => {
		if (!pending.length) return undefined;
		const content = capContext(renderPrompt("hooks/context.md", { source: "background", text: pending.join("\n\n") }));
		pending = [];
		return { customType: "octocode-hook-context", content, display: false };
	};
	api.bus.on("before_agent_start", async (_event, ctx) => {
		if (ctx.signal?.aborted) return;
		const message = takeContext();
		return message ? { message } : undefined;
	});
	api.bus.on("turn_end", async (event, ctx) => {
		if (
			ctx.signal?.aborted ||
			!event.toolResults?.length ||
			event.message.role !== "assistant" ||
			event.message.stopReason !== "toolUse"
		)
			return;
		const message = takeContext();
		return message
			? {
					entries: [...event.entries, { type: "custom_message" as const, ...message }],
				}
			: undefined;
	});
	// Sending may await an entire new turn; cleanup must not await that turn through the job that asked.
	const sendRewake = (reason: string) => {
		void Promise.resolve(
			sendHookFeedback(api, "octocode-hook-context", capContext(`Background hook feedback:\n${reason}`)),
		).catch(() => undefined);
	};
	return {
		reset,
		start(
			hook: HookCommand,
			event: HookEvent,
			run: (signal: AbortSignal) => Promise<HookRun>,
			warn: (message: string) => void,
		): void {
			if (closed) return;
			const signal = controller.signal;
			const launch = () => {
				if (signal.aborted) return;
				if (hook.protocol === "codex") codexRunning++;
				const task = run(signal)
					.then((result) => {
						if (signal.aborted) return;
						if (hook.protocol === "codex") {
							if (event === "Interrupt") {
								const verdict = interpret(event, result, "codex");
								const message = verdict.error ?? failureOf(hook, result, false) ?? verdict.systemMessage;
								if (message) warn(message);
								return;
							}
							const failure = failureOf(hook, result, false);
							if (failure) {
								warn(`Codex background hook ${failure}`);
								return;
							}
							if (result.code !== 0 || result.timedOut) return;
							const context = codexContext(event, result.stdout, warn);
							if (context)
								pending = [
									capContext([...pending, limitCodexContext(context, hook.additionalContextLimit)].join("\n\n")),
								];
							return;
						}
						if (hook.asyncRewake && result.code === 2) {
							const reason = visibleControls(result.stderr.trim() || result.stdout.trim());
							sendRewake(reason);
							return;
						}
						if (result.code !== 0) return;
						const context = backgroundContext(result.stdout);
						if (context) pending = [capContext([...pending, context].join("\n\n"))];
					})
					.catch(() => undefined)
					.finally(() => {
						active.delete(task);
						if (hook.protocol === "codex") {
							codexRunning--;
							if (!closed && !signal.aborted) codexQueue.shift()?.();
						}
					});
				active.add(task);
			};
			if (hook.protocol === "codex" && codexRunning >= 8) codexQueue.push(launch);
			else launch();
		},
	};
}
