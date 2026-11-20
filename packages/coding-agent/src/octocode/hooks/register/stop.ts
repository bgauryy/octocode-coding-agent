import { animationClock, Box, MOTION, Text } from "@octocodeai/octocode-tui";
import { redactSecrets, sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { formatDuration } from "../../shared/format.ts";
import { resultBlock } from "../../render/tool.ts";
import { runningWorkOf } from "../../shared/running-work.ts";
import { STATUS } from "../../shared/status.ts";
import { clipText, contentText, firstLine } from "../../shared/util.ts";
import { hookLabel } from "../config.ts";
import { backgroundTasks } from "./background-tasks.ts";
import {
	type Dispatch,
	type HookSession,
	STOP_CONTINUE_CAP,
	STOP_CONTINUE_RUN_CAP,
	STOP_PREFIX,
	STOP_TYPE,
} from "./types.ts";
import { commandsFor } from "../config/calls.ts";
import type { HookEvent } from "../catalog.ts";
import type { HookHandler } from "../contracts.ts";

/**
 * Shows `label` in the footer status while `work` runs, with its elapsed time in the TUI. For hooks that run after Octocode
 * removed its working indicator (Stop runs after `agent_end`): without it a slow hook looks like a finished, stuck run.
 */
async function withStatus<T>(ctx: FeatureContext, label: string, work: () => Promise<T>): Promise<T> {
	if (!ctx.hasUI) return work();
	const started = Date.now();
	const show = () => {
		const ms = Date.now() - started;
		ctx.ui.setStatus(STATUS.hooks, `${label}${ms >= 1_000 ? ` · ${formatDuration(ms)}` : ""}`);
	};
	show();
	// RPC clients get the label once; only the TUI repaints the time.
	const unsubscribe =
		ctx.mode === "tui" ? animationClock.subscribe(show, { everyMs: MOTION.tickMs, kind: "info" }) : undefined;
	try {
		return await work();
	} finally {
		unsubscribe?.();
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

export function registerStopHook(api: FeatureSetup, session: HookSession, dispatch: Dispatch, child = false): void {
	const work = runningWorkOf(api);
	/** Stop-hook continuations in a row (reset by a prompt or a tool call). */
	let stopContinues = 0;
	/** Continuations since the last prompt; unlike `stopContinues`, tool calls do not reset it. */
	let runContinues = 0;
	api.bus.on("before_agent_start", async () => {
		stopContinues = 0;
		runContinues = 0;
		return undefined;
	});
	api.bus.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) stopContinues = 0;
	});
	api.bus.on("agent_before_settle", async (event, ctx) => {
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
				background_tasks: backgroundTasks(work),
			})),
		);
		const feedback = [verdict.block, verdict.continueReason].filter(Boolean).join("\n\n");
		if (!feedback || stopContinues >= STOP_CONTINUE_CAP || runContinues >= STOP_CONTINUE_RUN_CAP) return undefined;
		stopContinues += 1;
		runContinues += 1;
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

/** `⚑ Stop hook`, then the hook's feedback: untrusted text, sanitized and previewed by resultBlock, never drawn as Markdown. */
export function registerStopRenderer(api: FeatureSetup): void {
	api.renderers.message(STOP_TYPE, (message, { expanded, outputPad }, theme) => {
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
