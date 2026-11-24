import type { Model, StreamOptions } from "../../types.ts";
import { iterateSseMessages, throwOnSseErrorEvent } from "../../utils/server-sent-events.ts";
import { redactProviderText } from "../../utils/error-body.ts";
import type { parseChunkUsage } from "../openai-completions/usage.ts";

import { getCompat } from "../openai-completions/compat.ts";
import {
	appendOpenAIReasoningDetail,
	isOpenAIReasoningDetail,
	type StreamedReasoningDetails,
} from "../openai-completions/reasoning-details.ts";

import { appendGrammarToolInputJsonDelta, type GrammarToolInputJsonBuffer } from "../constrained-sampling.ts";

interface DeltaCall {
	type?: string;
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
	custom?: { name?: string; input?: string };
}
interface Chunk {
	openrouter_metadata?: unknown;
	usage?: Parameters<typeof parseChunkUsage>[0];
	choices?: {
		finish_reason?: string | null;
		usage?: Chunk["usage"];
		delta?: Record<string, unknown> & { tool_calls?: DeltaCall[] };
	}[];
}
export interface CompletionsState extends StreamedReasoningDetails {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	error?: unknown;
	terminal?: boolean;
	streamStarted?: boolean;
	blockedPrompt?: string;
	usage?: Chunk["usage"];
	/** The last `openrouter_metadata` the stream carried; summarized into a diagnostic at the end. */
	routerMetadata?: unknown;
	/** Every cache marker the request carried was a 1h marker, so its reported writes are 1h writes (`parseChunkUsage`). */
	longCacheWrites?: boolean;
	reasoningField?: string;
	emptyToolInputs?: Set<string>;
}

export function normalizeCompletionsResponse(
	response: Response,
	state: CompletionsState,
	model: Model<"openai-completions">,
	options: StreamOptions,
	signal?: AbortSignal,
): Response {
	if (!response.ok || !response.body) return response;
	const body = response.body;
	const stableIds = new Map<number, string>();
	const grammarBuffers = new Map<number, { name: string; property: string; buffer: GrammarToolInputJsonBuffer }>();
	let finished = false;
	let toolCallSeen = false;
	const frames = (async function* () {
		for await (const event of iterateSseMessages(body, signal)) {
			throwOnSseErrorEvent(event);
			if (event.data === "[DONE]") break;
			let parsed: unknown;
			try {
				parsed = JSON.parse(event.data);
			} catch (error) {
				throw new Error(
					`Could not parse OpenAI Completions SSE event: ${error instanceof Error ? error.message : String(error)}; data=${redactProviderText(event.data)}`,
					{ cause: error },
				);
			}
			await options.onProviderStreamEvent?.(parsed, model);
			if (!parsed || typeof parsed !== "object") continue;
			if ("error" in parsed && parsed.error !== undefined)
				throw Object.assign(new Error(JSON.stringify(parsed)), { error: parsed.error });
			const chunk = (options.onProviderStreamEvent ? structuredClone(parsed) : parsed) as Chunk;
			const choice = chunk.choices?.[0];
			if (choice?.finish_reason) finished = true;
			if (chunk.openrouter_metadata !== undefined) state.routerMetadata = chunk.openrouter_metadata;
			const usage = chunk.usage ?? choice?.usage;
			if (usage) {
				state.usage = usage;
				chunk.usage = usage;
			}
			const delta = choice?.delta;
			if (delta) {
				for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
					if (typeof delta[field] === "string" && delta[field]) {
						state.reasoningField ??= field === "reasoning" ? (getCompat(model).reasoningReplayField ?? field) : field;
						delta.reasoning_content = delta[field];
						delete delta.reasoning;
						break;
					}
				}
				if (Array.isArray(delta.reasoning_details)) {
					for (const detail of delta.reasoning_details) {
						if (isOpenAIReasoningDetail(detail)) appendOpenAIReasoningDetail((state.details ??= []), detail);
					}
				}

				if (delta.tool_calls) {
					toolCallSeen = true;
					for (const call of delta.tool_calls) {
						if (call.function || !call.custom || call.index === undefined) continue;
						let entry = grammarBuffers.get(call.index);
						if (!entry) {
							const name = call.custom.name ?? "";
							entry = {
								name,
								property: state.grammarToolInputProperties?.get(name) ?? "input",
								buffer: { input: "", started: false, closed: false },
							};
							grammarBuffers.set(call.index, entry);
						}
						call.function = {
							name: entry.name,
							arguments:
								appendGrammarToolInputJsonDelta(
									entry.buffer,
									entry.property,
									entry.buffer.input + (call.custom.input ?? ""),
									false,
								) ?? "",
						};
						call.type = "function";
						delete call.custom;
					}
					delta.tool_calls = delta.tool_calls.filter((call) => call.function);
					for (const call of delta.tool_calls) {
						if (call.index === undefined) continue;
						const id = stableIds.get(call.index);
						if (id) call.id = id;
						else if (call.id) {
							stableIds.set(call.index, call.id);
							if (!call.function?.arguments) (state.emptyToolInputs ??= new Set()).add(call.id);
						}
					}
				}
			}
			if (choice?.finish_reason && grammarBuffers.size) {
				const closures: DeltaCall[] = [];
				for (const [index, entry] of grammarBuffers) {
					const argumentsDelta = appendGrammarToolInputJsonDelta(
						entry.buffer,
						entry.property,
						entry.buffer.input,
						true,
					);
					if (argumentsDelta !== undefined)
						closures.push({ index, id: stableIds.get(index), function: { arguments: argumentsDelta } });
				}
				if (closures.length) {
					const finishReason = choice.finish_reason;
					choice.finish_reason = null;
					yield new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
					yield new TextEncoder().encode(
						`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: closures }, finish_reason: finishReason }] })}\n\n`,
					);
					continue;
				}
			}
			yield new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		if (!finished && !getCompat(model).supportsFinishReason)
			yield new TextEncoder().encode(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolCallSeen ? "tool_calls" : "stop" }] })}\n\n`,
			);
	})();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done } = await frames.next();
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (error) {
					state.error = error;
					controller.error(error);
				}
			},
			async cancel() {
				await frames.return();
			},
		}),
		response,
	);
}
