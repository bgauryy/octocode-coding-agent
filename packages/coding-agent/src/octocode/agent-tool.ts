import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { Text } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../core/extensions/index.ts";
import { errorMessage, isRecord } from "../utils/guards.ts";

const MODES = { agent: "task", externalAgent: "external", coordinate: "coordinate", sendMessage: "message" } as const;
type Mode = (typeof MODES)[keyof typeof MODES];

/** Domain registrations supply their implementation; only the unified agent tool is exposed. */
export function agentModes() {
	const modes = new Map<Mode, ToolDefinition>();
	const collect: ExtensionAPI["registerTool"] = (tool) => {
		const mode = MODES[tool.name as keyof typeof MODES];
		if (!mode || modes.has(mode)) throw new Error(`Unexpected agent operation registration: ${tool.name}`);
		modes.set(mode, tool as ToolDefinition);
	};
	return {
		collect,
		register(pi: ExtensionAPI) {
			const entries = [...modes];
			pi.registerTool({
				name: "agent",
				label: "Agent",
				description:
					"Choose type and supply its arguments in input. " +
					entries.map(([type, tool]) => `${type}: ${tool.description}`).join("\n"),
				promptSnippet: modes.has("task")
					? "Delegate work, coordinate agents and exchange messages"
					: "Coordinate agents and exchange messages",
				promptGuidelines: entries.flatMap(([, tool]) => tool.promptGuidelines ?? []),
				parameters: Type.Object(
					{
						type: Type.Unsafe<Mode>({ type: "string", enum: entries.map(([type]) => type) }),
						input: Type.Unsafe<Record<string, unknown>>({
							anyOf: entries.map(([type, tool]) => ({ ...tool.parameters, description: `Arguments for type ${type}` })),
						}),
					},
					{ additionalProperties: false },
				),
				async execute(id, params, signal, onUpdate, ctx) {
					if (Object.keys(params).some((key) => key !== "type" && key !== "input")) {
						throw new Error("Agent arguments belong inside input; the envelope accepts only type and input.");
					}
					const tool = modes.get(params.type);
					if (!tool) throw new Error(`Invalid agent ${params.type} input; use that mode's schema.`);
					// The same validation a directly registered tool gets: optional nulls dropped, values coerced, the failing field named.
					let input: Record<string, unknown>;
					try {
						input = validateToolArguments(
							{ name: `agent ${params.type}`, description: tool.description, parameters: tool.parameters },
							{ type: "toolCall", id, name: `agent ${params.type}`, arguments: params.input as JsonObject },
						);
					} catch (error) {
						throw new Error(`Invalid agent ${params.type} input; use that mode's schema. ${errorMessage(error)}`);
					}
					const tagged = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => ({
						...result,
						details: { ...(isRecord(result.details) ? result.details : {}), agentType: params.type },
					});
					return tagged(
						await tool.execute(id, input, signal, onUpdate ? (update) => onUpdate(tagged(update)) : undefined, ctx),
					);
				},
				// Mode renderers read their own arguments from `context.args`, so they get the mode input, not the envelope.
				renderCall(args, theme, context) {
					const input = isRecord(args.input) ? args.input : {};
					return (
						modes.get(args.type)?.renderCall?.(input, theme, { ...context, args: input }) ??
						new Text(`Agent ${args.type ?? ""}`, 0, 0)
					);
				},
				renderResult(result, options, theme, context) {
					const envelope: Record<string, unknown> = isRecord(context?.args) ? context.args : {};
					// A thrown error has no agentType in its details; the call's own type still names the mode.
					const type = (isRecord(result.details) ? result.details.agentType : undefined) ?? envelope.type;
					const input = isRecord(envelope.input) ? envelope.input : {};
					return (
						modes.get(type as Mode)?.renderResult?.(result, options, theme, { ...context, args: input }) ??
						new Text(
							result.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
							0,
							0,
						)
					);
				},
			});
		},
	};
}

/** Interpret the mode for domain policy while the public call and user hooks retain the agent envelope. */
export function agentOperation<T extends { toolName: string; input: Record<string, unknown> }>(event: T): T {
	if (event.toolName !== "agent" || !isRecord(event.input.input)) return event;
	const name = Object.entries(MODES).find(([, type]) => type === event.input.type)?.[0];
	return name ? { ...event, toolName: name, input: event.input.input } : event;
}
