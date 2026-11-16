import type { Model, Tool, TranscriptContext } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import { getCurrentTools, getInitialSystemMessage } from "../../utils/transcript.ts";
import { getAnthropicCompat } from "../anthropic-messages/compat.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { registerCredentialFetch } from "../anthropic-messages/federation.ts";
import { hasStrictToolDowngrade, rememberStrictToolDowngrade } from "../anthropic-messages/strict-tool-downgrades.ts";
import { anthropicToolSchema } from "./anthropic-map.ts";
import { repairAnthropicSse } from "./anthropic-sse.ts";
import { prepareSdkRequest } from "./transport.ts";

export interface StrictFallback {
	message?: string;
}
const LIMITS = [
	"The compiled grammar is too large",
	"Too many strict tools (",
	"Schemas contains too many parameters with union types (",
];
export function anthropicStrictFetch(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
	state: StrictFallback,
	finalizeRequest?: (body: unknown) => void,
): typeof globalThis.fetch {
	const current = getCurrentTools(context.messages);
	const compat = getAnthropicCompat(model);
	const initial = getInitialSystemMessage(context.messages);
	const inline = resolveToolLoadingMode(model.api, compat) === "changes" && !!initial?.toolsAdded?.length;
	const declared = inline
		? [
				...initial.toolsAdded!,
				...context.messages
					.filter((message) => message !== initial)
					.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : [])),
			]
		: current;
	const relax = (body: Record<string, unknown>) => {
		const queues = new Map<string, Tool[]>();
		for (const definition of declared) {
			const queue = queues.get(definition.name) ?? [];
			queue.push(definition);
			queues.set(definition.name, queue);
		}
		let changed = false;
		const visit = (value: unknown) => {
			if (Array.isArray(value)) {
				value.forEach(visit);
				return;
			}
			if (!value || typeof value !== "object") return;
			const object = value as Record<string, unknown>;
			if (object.input_schema && typeof object.name === "string") {
				const definition = queues.get(object.name)?.shift();
				const config = definition?.constrainedSampling;
				if (
					object.strict === true &&
					definition &&
					config &&
					config.type === "json_schema" &&
					config.strict === "prefer"
				) {
					delete object.strict;
					object.input_schema = anthropicToolSchema(definition, compat.supportsStrictTools, true).schema;
					changed = true;
				}
			}
			for (const [key, child] of Object.entries(object)) if (!["input_schema", "input"].includes(key)) visit(child);
		};
		visit(body.tools);
		visit(body.messages);
		return changed;
	};
	const fetch = options.fetch ?? globalThis.fetch;
	const wrapper: typeof globalThis.fetch = async (input, init) => {
		const response = repairAnthropicSse(await fetch(input, init));
		if (response.status !== 400 || hasStrictToolDowngrade(model, current) || options.signal?.aborted) return response;
		const body = JSON.parse(init?.body as string) as Record<string, unknown>;
		if (!relax(body)) return response;
		const error = (await response
			.clone()
			.json()
			.catch(() => undefined)) as { error?: { type?: string; message?: string } } | undefined;
		const message = error?.error?.message;
		if (error?.error?.type !== "invalid_request_error" || !message || !LIMITS.some((limit) => message.includes(limit)))
			return response;
		await response.body?.cancel();
		rememberStrictToolDowngrade(model, current);
		state.message = message;
		const prepared = await prepareSdkRequest(
			model,
			options,
			input,
			{ ...init, body: JSON.stringify(body) },
			undefined,
			finalizeRequest,
		);
		return repairAnthropicSse(await fetch(input, prepared));
	};
	registerCredentialFetch(wrapper, fetch);
	return wrapper;
}
