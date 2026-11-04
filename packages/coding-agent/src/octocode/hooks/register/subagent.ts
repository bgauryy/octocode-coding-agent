import { renderInstruction } from "../../../core/prompt-template.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { commandsFor } from "../config/calls.ts";
import type { HookVerdict } from "../contracts.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { PARENT_SESSION_ENV, PARENT_TRANSCRIPT_ENV } from "../../../../../common/src/env.ts";
import { contentText } from "../../shared/util.ts";
import { capContext } from "../runner.ts";
import {
	CONTEXT_TYPE,
	type Dispatch,
	type HookHostMetadata,
	type HookSession,
	STOP_CONTINUE_CAP,
	STOP_PREFIX,
	STOP_TYPE,
} from "./types.ts";

/**
 * Stop: when the agent would settle after a completed run, a blocking hook sends it on with the reason (Claude
 * Code's loop guards: `stop_hook_active` while continuing, at most 8 continuations in a row unless a tool runs).
 */
export function registerSubagentHooks(
	api: ExtensionAPI,
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
	api.on("session_start", async (event) => {
		codexStart = event.reason === "startup" || event.reason === "fork";
		stopContinues = 0;
	});
	api.on("before_agent_start", async (_event, ctx) => {
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
				contexts.push(
					capContext(
						renderInstruction("notices/hooks/context.md", {
							source: `${protocol} SubagentStart`,
							text: verdict.context,
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
	api.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) stopContinues = 0;
	});
	api.on("agent_before_settle", async (event, ctx) => {
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
