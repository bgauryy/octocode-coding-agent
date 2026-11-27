import type { ResponseStreamEvent } from "./openai-wire-types.ts";
import type { ToolCall, TranscriptContext } from "../../types.ts";
import { ResponsesArtifacts } from "../openai-responses-shared/stream-artifacts.ts";
import { responseAnnotations } from "../openai-responses-shared/rich-content.ts";
import { parseTextSignature } from "../openai-responses-shared/text-signature.ts";
import { appendGrammarToolInputJsonDelta, resolveGrammarConstrainedSampling } from "../constrained-sampling.ts";
import type { SdkMapping } from "./stream.ts";

export function responsesRich(context: TranscriptContext | undefined): NonNullable<SdkMapping["onPart"]> {
	let artifacts: ResponsesArtifacts | undefined;
	const custom = new Map<
		string,
		{ block: ToolCall; index: number; property: string; input: string; started: boolean; closed: boolean }
	>();
	const ignored = new Set<string>();
	return (part, output, stream) => {
		artifacts ??= new ResponsesArtifacts(output, stream);
		if (part.type !== "raw") {
			if (part.type === "tool-input-start" && (part.providerExecuted || part.inputEncoding === "text")) {
				ignored.add(part.id);
				return true;
			}
			if ((part.type === "tool-input-delta" || part.type === "tool-input-end") && ignored.has(part.id)) return true;
			if (part.type === "tool-call" && (part.providerExecuted || ignored.has(part.toolCallId))) return true;
			return ["file", "source", "tool-result", "tool-error"].includes(part.type);
		}
		const event = part.rawValue as ResponseStreamEvent;
		if (artifacts.accept(event)) return true;
		if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
			const item = event.item;
			if (item.type === "custom_tool_call") {
				let entry = custom.get(item.id ?? item.call_id);
				if (!entry) {
					const definition = context?.messages
						.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
						.find((tool) => tool.name === item.name);
					const grammar = definition ? resolveGrammarConstrainedSampling(definition, true) : undefined;
					if (!grammar) throw new Error(`Unknown grammar tool: ${item.name}`);
					const block: ToolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: { [grammar.inputProperty]: item.input ?? "" },
					};
					entry = {
						block,
						index: output.content.length,
						property: grammar.inputProperty,
						input: "",
						started: false,
						closed: false,
					};
					custom.set(item.id ?? item.call_id, entry);
					output.content.push(block);
					stream.push({ type: "toolcall_start", contentIndex: entry.index, partial: output });
				}
				const close = event.type === "response.output_item.done";
				const delta = appendGrammarToolInputJsonDelta(entry, entry.property, item.input ?? entry.input, close);
				entry.block.arguments = { [entry.property]: entry.input };
				if (delta !== undefined)
					stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: output });
				if (close)
					stream.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: entry.block, partial: output });
				return true;
			}
			if (!["message", "reasoning", "function_call"].includes(item.type)) {
				artifacts.upsert(item, event.output_index);
				return true;
			}
			if (item.type === "message" && event.type === "response.output_item.done") {
				const block = output.content.find(
					(block) => block.type === "text" && parseTextSignature(block.textSignature)?.id === item.id,
				);
				if (block?.type === "text") {
					const annotations = responseAnnotations(item);
					if (annotations.length) block.annotations = annotations;
				}
			}
		}
		if (event.type === "response.custom_tool_call_input.delta") {
			const entry = custom.get(event.item_id);
			if (entry) {
				const delta = appendGrammarToolInputJsonDelta(entry, entry.property, entry.input + event.delta, false);
				entry.block.arguments = { [entry.property]: entry.input };
				if (delta !== undefined)
					stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: output });
			}
			return true;
		}
		if (event.type === "response.completed" || event.type === "response.incomplete")
			artifacts.finish(event.response.output ?? []);
		return false;
	};
}
