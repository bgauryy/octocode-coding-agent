import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { HookEvent } from "./catalog.ts";
import { type HookPrompt, type HookRun, HOOK_OUTPUT_MAX_BYTES, type HookVerdict } from "./contracts.ts";
import { parseJson } from "../shared/util.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";

export type PromptEvaluator = (request: { prompt: string; model?: string; signal: AbortSignal }) => Promise<string>;

export const HOOK_EVALUATION_SYSTEM_PROMPT = renderInstruction("workflows/hook-evaluation.md");

export function createPromptEvaluator(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): PromptEvaluator {
	return async (request) => {
		const candidates = request.model
			? ctx.modelRegistry
					.getAll()
					.filter((model) => model.id === request.model || `${model.provider}/${model.id}` === request.model)
			: [];
		const model = request.model ? (candidates.length === 1 ? candidates[0] : undefined) : ctx.model;
		if (!model) throw new Error("Prompt hook model is unavailable or ambiguous");
		const response = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: HOOK_EVALUATION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
				},
				{ signal: request.signal, maxTokens: 1024 },
			)
			.result();
		if (response.stopReason === "error" || response.stopReason === "aborted")
			throw new Error(response.errorMessage || "Prompt evaluation failed");
		return response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	};
}

export async function runPromptHook(
	hook: HookPrompt,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
	evaluate?: PromptEvaluator,
): Promise<HookRun> {
	const empty: HookRun = {
		code: null,
		stdout: "",
		stderr: "",
		timedOut: false,
	};
	if (signal?.aborted) return empty;
	if (!evaluate) return { ...empty, stderr: "Prompt hook evaluator is unavailable" };
	const input = JSON.stringify(payload);
	let consumed = false;
	let prompt = hook.prompt.replace(/(\\)?\$ARGUMENTS\b/g, (_match, escaped: string | undefined) => {
		if (escaped) return "$ARGUMENTS";
		consumed = true;
		return input;
	});
	if (!consumed) prompt += `\n\n${input}`;
	const controller = new AbortController();
	let timedOut = false;
	let rejectCancelled: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectCancelled = reject;
	});
	const cancel = () => {
		controller.abort();
		rejectCancelled(new Error("Prompt hook cancelled"));
	};
	signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		cancel();
	}, hook.timeoutMs);
	try {
		const stdout = await Promise.race([evaluate({ prompt, model: hook.model, signal: controller.signal }), cancelled]);
		if (Buffer.byteLength(stdout) > HOOK_OUTPUT_MAX_BYTES) throw new Error("Prompt hook response exceeds 64 KiB");
		return { ...empty, code: 0, stdout };
	} catch (error) {
		return {
			...empty,
			timedOut,
			stderr: signal?.aborted ? "" : errorMessage(error),
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

export function interpretPromptHook(event: HookEvent, run: HookRun, continueOnBlock = false): HookVerdict {
	if (run.code !== 0) return {};
	const value = parseJson(run.stdout);
	if (
		!isRecord(value) ||
		typeof value.ok !== "boolean" ||
		(value.reason !== undefined && typeof value.reason !== "string") ||
		(value.impossible !== undefined && typeof value.impossible !== "boolean") ||
		(!value.ok && (typeof value.reason !== "string" || !value.reason.trim()))
	)
		return {
			error: "Prompt hook must return JSON with boolean ok and a reason when false",
		};
	if (value.ok || ((event === "Stop" || event === "SubagentStop") && value.impossible === true)) return {};
	const reason = visibleControls((value.reason as string).trim());
	if (event === "PostToolUse" || event === "PostToolUseFailure")
		return {
			context: reason,
			...(event === "PostToolUse" && !continueOnBlock ? { haltTurn: true as const } : {}),
		};
	return {
		block: reason,
		...(event === "PreToolUse" && !continueOnBlock ? { haltTurn: true as const } : {}),
	};
}
