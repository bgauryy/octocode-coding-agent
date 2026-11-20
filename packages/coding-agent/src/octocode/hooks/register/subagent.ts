import { renderPrompt } from "../../../core/prompt-template.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { commandsFor } from "../config/calls.ts";
import type { HookVerdict } from "../contracts.ts";
import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { PARENT_SESSION_ENV, PARENT_TRANSCRIPT_ENV } from "@octocodeai/octocode-common/env";
import { contentText } from "../../shared/util.ts";
import { capContext } from "../runner.ts";
import {
	CONTEXT_TYPE,
	type Dispatch,
	type HookHostMetadata,
	type HookSession,
	STOP_CONTINUE_CAP,
	STOP_CONTINUE_RUN_CAP,
	STOP_PREFIX,
	STOP_TYPE,
} from "./types.ts";

/**
 * Stop: when the agent would settle after a completed run, a blocking hook sends it on with the reason (Claude
 * Code's loop guards: `stop_hook_active` while continuing, at most 8 continuations in a row unless a tool runs).
 */
export function registerSubagentHooks(
	api: FeatureSetup,
	session: HookSession,
	dispatch: Dispatch,
	env: NodeJS.ProcessEnv,
	metadata: (() => HookHostMetadata) | undefined,
): void {
	let codexStart = false;
	/** Protocols whose SubagentStart hooks already ran: they run once when the subagent starts, not on every turn. */
	const started = new Map<"claude" | "codex", string | undefined>();
	let stopContinues = 0;
	/** Continuations since the last prompt; tool calls do not reset it. */
	let runContinues = 0;
	const agentType = metadata?.().agentType || "general";
	const identity = (ctx: FeatureContext, protocol: "claude" | "codex", stop: boolean): Record<string, unknown> => ({
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
	const ready = (ctx: FeatureContext, protocol: "claude" | "codex"): boolean => {
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
	api.bus.on("session_start", async (event) => {
		codexStart = event.reason === "startup" || event.reason === "fork";
		started.clear();
		stopContinues = 0;
		runContinues = 0;
	});
	api.bus.on("before_agent_start", async (_event, ctx) => {
		stopContinues = 0;
		runContinues = 0;
		const contexts: string[] = [];
		const contextKeys: string[] = [];
		for (const protocol of ["claude", "codex"] as const) {
			if (!commandsFor(session.config, "SubagentStart", [agentType]).some((hook) => hook.protocol === protocol))
				continue;
			if (protocol === "codex" && !codexStart) continue;
			if (protocol === "codex") codexStart = false;
			if (!ready(ctx, protocol)) continue;
			// Later turns only re-offer the context the first run produced (it can have left the projection, e.g. by compaction).
			if (!started.has(protocol)) {
				const verdict = await dispatch(
					ctx,
					"SubagentStart",
					[agentType],
					() => identity(ctx, protocol, false),
					ctx.signal,
					protocol,
				);
				if (ctx.signal?.aborted) return;
				started.set(protocol, verdict.context);
			}
			const text = started.get(protocol);
			if (!text) continue;
			const key = sha256(`${protocol}\0${text}`);
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
				contexts.push(
					capContext(
						renderPrompt("hooks/context.md", {
							source: `${protocol} SubagentStart`,
							text,
						}),
					),
				);
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
	api.bus.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) stopContinues = 0;
	});
	api.bus.on("agent_before_settle", async (event, ctx) => {
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
		if (!feedback || stopContinues >= STOP_CONTINUE_CAP || runContinues >= STOP_CONTINUE_RUN_CAP) return;
		stopContinues += 1;
		runContinues += 1;
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
