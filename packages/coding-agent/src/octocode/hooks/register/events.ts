import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { notify } from "../../shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "../../shared/env.ts";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { claudeSessionEndOverride } from "../profiles.ts";
import { capContext } from "../runner.ts";
import { CONTEXT_TYPE, type Dispatch, type HookHostMetadata, type HookSession } from "./types.ts";

/** Native PreCompact remains observational; source-profile vetoes cancel through the core owner. */
export function registerPreCompactHook(pi: ExtensionAPI, dispatch: Dispatch): void {
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

export function registerSessionEndHook(
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

export function registerPostCompactHook(pi: ExtensionAPI, dispatch: Dispatch): void {
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

export function registerPostToolBatchHook(pi: ExtensionAPI, dispatch: Dispatch): void {
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

export function registerPromptHook(pi: ExtensionAPI, dispatch: Dispatch): void {
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

export function registerInterruptHook(
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
