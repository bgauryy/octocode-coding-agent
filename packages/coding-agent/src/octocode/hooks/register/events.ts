import { renderPrompt } from "../../../core/prompt-template.ts";
import type { FeatureSetup } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { compactionOutcome } from "../../../core/compaction/outcome-read.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { claudeSessionEndOverride } from "../profiles.ts";
import { capContext } from "../runner.ts";
import { CONTEXT_TYPE, type Dispatch, type HookHostMetadata, type HookSession } from "./types.ts";

/**
 * Native PreCompact remains observational; source-profile vetoes cancel through the core owner. `trigger` keeps the
 * hosts' `manual` or `auto`; `trigger_source` says who or what asked (`user`, `agent`, `threshold`, `overflow`).
 * `custom_instructions` is the focus a manual compaction was given ("" without one), and `custom_instructions_source`
 * says whose it is: the user's `/compact` text or the agent's own `compact` focus.
 */
export function registerPreCompactHook(api: FeatureSetup, dispatch: Dispatch): void {
	api.bus.on("session_before_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const source = event.reason === "manual" ? (event.requestedBy ?? "user") : event.reason;
		// As in Claude Code, an automatic compaction has no instructions of its own.
		const instructions = trigger === "manual" && event.customInstructions?.trim() ? event.customInstructions : "";
		const verdict = await dispatch(
			ctx,
			"PreCompact",
			[trigger],
			() => ({
				trigger,
				custom_instructions: instructions,
				...(instructions ? { custom_instructions_source: source } : {}),
				trigger_source: source,
				tokens_before: event.preparation?.tokensBefore ?? null,
			}),
			event.signal,
		);
		return verdict.cancelCompaction && !event.signal?.aborted ? { cancel: true } : undefined;
	});
}

export function registerSessionEndHook(
	api: FeatureSetup,
	session: HookSession,
	dispatch: Dispatch,
	env: NodeJS.ProcessEnv,
): void {
	api.bus.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") return;
		// Native and Claude-format hooks (from settings, hook files and plugins) share one budget: 1.5 s, raised to the
		// longest hook timeout up to 60 s. Codex keeps its own 3 s.
		const run = async (protocol: "octocode" | "claude" | "codex", reason: string) => {
			const configuredBudget = Math.min(
				60_000,
				Math.max(
					1500,
					...session.config.SessionEnd.flatMap((group) =>
						group.hooks.filter((hook) => hook.protocol !== "codex").map((hook) => hook.timeoutMs),
					),
				),
			);
			const budget = protocol === "codex" ? 3000 : (claudeSessionEndOverride(env) ?? configuredBudget);
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), budget);
			try {
				await dispatch(
					ctx,
					"SessionEnd",
					[reason],
					() => ({ reason }),
					abort.signal,
					protocol === "codex" ? "codex" : ["octocode", "claude"],
				);
			} finally {
				clearTimeout(timer);
			}
		};
		await Promise.all([
			run("octocode", event.reason === "new" ? "clear" : event.reason === "resume" ? "resume" : "other"),
			...(event.reason === "quit" && !envFlag(env, SUBAGENT_ENV) ? [run("codex", "other")] : []),
		]);
	});
}

/**
 * PostCompact: Claude's and Codex's `trigger` and `compact_summary`, plus the outcome the compaction entry records:
 * who asked, the tokens before and the estimated tokens after, whose focus it had, and the carried rules it lifted.
 */
export function registerPostCompactHook(api: FeatureSetup, dispatch: Dispatch): void {
	api.bus.on("session_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const verdict = await dispatch(ctx, "PostCompact", [trigger], () => {
			const outcome = compactionOutcome(event.compactionEntry);
			return {
				trigger,
				compact_summary: event.compactionEntry.summary,
				trigger_source: outcome.trigger ?? (event.reason === "manual" ? "user" : event.reason),
				tokens_before: outcome.tokensBefore ?? null,
				tokens_after: outcome.estimatedTokensAfter ?? null,
				focus_source: outcome.focusSource ?? null,
				lifted: outcome.lifted,
			};
		});
		if (verdict.stop) ctx.abort("internal");
		if (verdict.context && !verdict.stop && !ctx.signal?.aborted) {
			await api.session.sendMessage(
				{
					customType: CONTEXT_TYPE,
					content: capContext(renderPrompt("hooks/context.md", { source: "PostCompact", text: verdict.context })),
					display: false,
				},
				{ triggerTurn: false },
			);
		}
	});
}

export function registerPostToolBatchHook(api: FeatureSetup, dispatch: Dispatch): void {
	api.bus.on("turn_end", async (event, ctx) => {
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

export function registerPromptHook(api: FeatureSetup, dispatch: Dispatch): void {
	api.bus.on("user_input", async (event, ctx) => {
		const verdict = await dispatch(ctx, "UserPromptSubmit", [], () => ({ prompt: event.text }), ctx.signal, "codex");
		if (verdict.block && ctx.hasUI) notify(ctx.ui, `Blocked by a UserPromptSubmit hook: ${verdict.block}`, "warning");
		return {
			block: !!verdict.block,
			additionalContext: verdict.context
				? [capContext(renderPrompt("hooks/context.md", { source: "UserPromptSubmit", text: verdict.context }))]
				: [],
		};
	});
	api.bus.on("input", async (event, ctx) => {
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
			await api.session.sendMessage(
				{
					customType: CONTEXT_TYPE,
					content: capContext(renderPrompt("hooks/context.md", { source: "UserPromptSubmit", text: verdict.context })),
					display: false,
				},
				{ triggerTurn: false },
			);
		}
		return { action: "continue" };
	});
}

export function registerInterruptHook(
	api: FeatureSetup,
	session: HookSession,
	dispatch: Dispatch,
	metadata: (() => HookHostMetadata) | undefined,
): void {
	api.bus.on("agent_interrupted", async (event, ctx) => {
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
