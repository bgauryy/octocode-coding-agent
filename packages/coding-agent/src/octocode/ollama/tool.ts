import { StringEnum } from "@octocodeai/octocode-contacts/schema";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { isRecord } from "../../utils/guards.ts";
import { resultBlock, resultText, toolHeader } from "../shared/render.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { textResult } from "../shared/util.ts";
import { type FreellamaRunner, runFreellama } from "./freellama.ts";

const TASK_KINDS = ["completion", "coding", "code-repair", "long-context"] as const;
const OBJECTIVES = ["fastest", "balanced", "quality"] as const;
const DEFAULT_TASK_SECONDS = 300;
const MAX_TASK_SECONDS = 1800;
/** `models` and `route` read server state only. */
const READ_TIMEOUT_MS = 30_000;
/** Time the CLI gets past the server deadline to report it. */
const REPORT_GRACE_MS = 15_000;

interface OllamaDetails {
	action: "models" | "route" | "task";
	model?: string;
	models?: number;
	confidence?: string;
	promptTokens?: number;
	outputTokens?: number;
	tokensPerSecond?: number;
	doneReason?: string;
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const gb = (bytes: unknown): string => (num(bytes) === undefined ? "?" : `${(Number(bytes) / 1e9).toFixed(1)} GB`);

function modelsResult(receipt: unknown) {
	const models = Array.isArray(record(receipt).models) ? (record(receipt).models as unknown[]).map(record) : [];
	const lines = models.map((model) => {
		const capabilities = Array.isArray(model.capabilities) ? model.capabilities.join(", ") : "";
		const context = num(model.advertised_context);
		return [
			str(model.name) ?? "?",
			capabilities && `capabilities: ${capabilities}`,
			gb(model.size),
			context && `context ${context}`,
			model.resident === true ? "loaded" : "not loaded",
		]
			.filter(Boolean)
			.join(" · ");
	});
	const text = lines.length > 0 ? lines.join("\n") : "No models are installed in Ollama.";
	return textResult<OllamaDetails>(text, { action: "models", models: models.length });
}

function routeResult(receipt: unknown) {
	const route = record(receipt);
	const model = str(route.selected_model);
	const reasons = Array.isArray(route.reasons) ? route.reasons.join(", ") : "";
	const confidence = str(route.confidence);
	const text = [
		`Model: ${model ?? "none"}`,
		confidence && `Confidence: ${confidence}`,
		reasons && `Reasons: ${reasons}`,
	]
		.filter(Boolean)
		.join("\n");
	return textResult<OllamaDetails>(text, {
		action: "route",
		...(model ? { model } : {}),
		...(confidence ? { confidence } : {}),
	});
}

function taskResult(receipt: unknown) {
	const root = record(receipt);
	const response = record(root.response);
	const message = record(response.message);
	const metrics = record(root.metrics);
	const model = str(record(root.route).selected_model) ?? str(response.model);
	// A low-confidence route is a capability-only fallback (any resident model that can complete): weigh its reply.
	const confidence = str(record(root.route).confidence);
	const doneReason = str(response.done_reason);
	const details: OllamaDetails = {
		action: "task",
		...(model ? { model } : {}),
		...(confidence ? { confidence } : {}),
		...(num(metrics.prompt_tokens) === undefined ? {} : { promptTokens: num(metrics.prompt_tokens) }),
		...(num(metrics.output_tokens) === undefined ? {} : { outputTokens: num(metrics.output_tokens) }),
		...(num(metrics.output_tokens_per_second) === undefined
			? {}
			: { tokensPerSecond: Math.round(num(metrics.output_tokens_per_second)!) }),
		...(doneReason ? { doneReason } : {}),
	};
	const receiptLine = [
		model,
		confidence && `${confidence} confidence route`,
		details.outputTokens !== undefined && `${details.promptTokens ?? "?"} in / ${details.outputTokens} out tokens`,
		details.tokensPerSecond !== undefined && `${details.tokensPerSecond} tok/s`,
	]
		.filter(Boolean)
		.join(" · ");
	const cut = doneReason === "length" ? "\n[Stopped at the output token limit; the reply may be cut.]" : "";
	const thinking = str(message.thinking);
	const reply = str(message.content)?.trim() ?? (thinking ? `[thinking only]\n${thinking}` : "");
	return textResult(`[${receiptLine}]\n${reply || "(empty reply)"}${cut}`, details);
}

const DESCRIPTION =
	"Run a prompt on a local Ollama model through FreeLlama, which picks an installed model within memory limits. " +
	"models: installed models; route: the model a task would use; task: one prompt, reply with model and token receipt. " +
	"Needs `freellama serve` running. The prompt is the model's only context; replies stop at the output limit.";

/** The `ollama` tool. `run` is the CLI boundary; tests replace it. */
export function registerOllamaTool(api: ExtensionAPI, run: FreellamaRunner = runFreellama): void {
	api.registerTool(
		timedTool({
			name: "ollama",
			label: "Ollama",
			defaultActive: true,
			description: DESCRIPTION,
			promptSnippet: "Offload a self-contained prompt to a local Ollama model",
			parameters: Type.Object({
				action: StringEnum(["models", "route", "task"] as const),
				prompt: Type.Optional(Type.String({ description: "task: the whole prompt, as one user message" })),
				task: Type.Optional(
					StringEnum(TASK_KINDS, { description: "route/task: task kind for model routing (default completion)" }),
				),
				objective: Type.Optional(
					StringEnum(OBJECTIVES, {
						description:
							"route/task: fastest, balanced (server default) or quality (needs a policy unless model is set)",
					}),
				),
				model: Type.Optional(Type.String({ description: "route/task: exact installed model tag; omit to route" })),
				timeoutSeconds: Type.Optional(
					Type.Integer({ description: `task: total deadline in seconds (default ${DEFAULT_TASK_SECONDS})` }),
				),
			}),
			async execute(_toolCallId, params, signal) {
				signal?.throwIfAborted();
				if (params.action === "models")
					return modelsResult(await run(["models"], { signal, timeoutMs: READ_TIMEOUT_MS }));
				const routing = [
					"--task",
					params.task ?? "completion",
					...(params.objective ? ["--objective", params.objective] : []),
					...(params.model ? ["--model", params.model] : []),
				];
				if (params.action === "route")
					return routeResult(await run(["route", ...routing], { signal, timeoutMs: READ_TIMEOUT_MS }));
				const prompt = params.prompt?.trim();
				if (!prompt) throw new Error("ollama task needs a prompt.");
				const seconds = Math.min(
					Math.max(Math.round(params.timeoutSeconds ?? DEFAULT_TASK_SECONDS), 1),
					MAX_TASK_SECONDS,
				);
				// `--` ends the options, so a prompt that starts with `-` stays the prompt.
				const args = ["task", ...routing, "--timeout-seconds", String(seconds), "--", prompt];
				return taskResult(await run(args, { signal, timeoutMs: seconds * 1000 + REPORT_GRACE_MS }));
			},
			renderCall(args, theme, context) {
				const action = typeof args?.action === "string" ? args.action : "";
				const model = typeof args?.model === "string" ? ` ${args.model}` : "";
				return toolHeader(theme, context, "Ollama", `${action}${model}`);
			},
			renderResult(result, _options, theme, context) {
				const text = resultText(result);
				const [summary = "", ...rest] = text.split("\n");
				if (context.isError) return resultBlock(theme, context, { summary, body: rest.join("\n") });
				return resultBlock(theme, context, { summary, body: rest.join("\n"), ...timingOf(result.details) });
			},
		}),
	);
}
