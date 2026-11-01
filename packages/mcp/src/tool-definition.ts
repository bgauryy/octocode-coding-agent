import { Container, Spacer, Text, VisualLinePreview } from "@octocodeai/octocode-tui";
import { visibleControls } from "../../common/src/sanitize.ts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema } from "typebox";
import type { CallToolResult, Tool as McpTool } from "./client/index.ts";
import type { McpContext, McpToolDefinition, McpToolNamespace, McpToolRenderers } from "./host/types.ts";
import { hostRender, hostUi } from "./host.ts";
import type { McpExposure } from "./config.ts";
import { firstSentence, thinParameters } from "./presentation/declaration.ts";
import { envelopeHint, queriesCap } from "./presentation/validation-hint.ts";
import {
	type McpToolCaller,
	type McpToolDetails,
	convertMcpResult,
	createMcpResultSchema,
	toParameters,
} from "./tools.ts";

const OUTPUT_PREVIEW_LINES = 5;

const declaresReason = (schema: Record<string, unknown>): boolean => {
	const properties = schema.properties;
	return typeof properties === "object" && properties !== null && "reason" in properties;
};

/**
 * Every native tool takes a required `reason`, so models add one to MCP calls too; a server schema that forbids extra
 * keys then rejects the call. The server never sees the key, so dropping it changes no request it could accept.
 */
const dropReason = <T>(args: T): T => {
	if (typeof args !== "object" || args === null || Array.isArray(args) || !("reason" in args)) return args;
	const { reason: _reason, ...rest } = args as Record<string, unknown>;
	return rest as T;
};
interface PreparedMcpCall {
	args: Record<string, unknown>;
	/** Applied to the server's result before `convertResult`. */
	review?: (result: CallToolResult) => CallToolResult;
}

interface McpToolPresentation extends McpToolRenderers {
	label?: string;
	outputSchema?: TSchema;
	/** Rewrites the arguments just before the server call (the model-facing schema is unchanged) and may review the raw result. */
	prepareCall?: (args: Record<string, unknown>, ctx: McpContext) => PreparedMcpCall | Promise<PreparedMcpCall>;
	convertResult: (result: CallToolResult, ctx: McpContext) => Promise<AgentToolResult<McpToolDetails>>;
}

export interface McpToolDefinitionOptions {
	presentation?: McpToolPresentation;
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	/** False keeps the tool out of the default tool selection: only a selection that names it activates it. */
	defaultActive?: boolean;
	namespace: McpToolNamespace;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
	/**
	 * Declare the tool as a thin stub: `summary` (else the description's first sentence) and an open input object. The
	 * model reads the tool's typed signature in its server's system prompt section; calls are validated against the
	 * server's own input schema, and a failed validation shows `signature()`.
	 */
	compact?: { signature: () => string | undefined; summary?: string };
}

export function createMcpToolDefinition(options: McpToolDefinitionOptions): McpToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title;
	const label = options.presentation?.label ?? `${server}/${tool.name}`;
	const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
	const inputSchema = toParameters(tool.inputSchema);
	const { compact } = options;
	return {
		name: options.name,
		label,
		// Providers declare input schemas; include the server's output contract in the same cached tool description.
		// A thin declaration leaves both to the typed signature, whose return type is the output schema.
		description: compact
			? (compact.summary ?? firstSentence(description))
			: tool.outputSchema
				? `${description}\n\nServer result schema:\n${JSON.stringify(tool.outputSchema)}`
				: description,
		parameters: compact ? thinParameters(inputSchema) : inputSchema,
		...(compact ? { validationParameters: inputSchema } : {}),
		// Shown after a failed validation: a failure at the top level names the one accepted call shape; any other
		// names the working next step for an over-long `queries` batch, and a compact tool adds its typed signature.
		...(compact || queriesCap(tool.inputSchema) !== undefined
			? {
					validationHint: ({ envelope }) => {
						const shape = envelope ? envelopeHint(options.name, tool.inputSchema) : undefined;
						if (shape) return shape;
						const cap = queriesCap(tool.inputSchema);
						const block = compact?.signature();
						const hints = [
							cap === undefined
								? ""
								: `If queries has more than ${cap} items: send at most ${cap} per call and put the rest in another call in the same turn.`,
							block ? `Expected signature (TypeScript):\n${block}` : "",
						].filter(Boolean);
						return hints.length ? hints.join("\n\n") : undefined;
					},
				}
			: {}),
		...(declaresReason(tool.inputSchema) ? {} : { prepareArguments: dropReason }),
		...(options.presentation
			? options.presentation.outputSchema
				? { outputSchema: options.presentation.outputSchema }
				: {}
			: { outputSchema: createMcpResultSchema(tool.outputSchema) }),
		exposure: options.exposure,
		...(options.defaultActive === false ? { defaultActive: false } : {}),
		namespace: options.namespace,
		...(({ renderCall, renderResult }) => ({ renderCall, renderResult }))(
			options.presentation ?? createMcpToolRenderers(label),
		),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const client = await options.getClient();
			const requested = (params ?? {}) as Record<string, unknown>;
			const call = (await options.presentation?.prepareCall?.(requested, ctx)) ?? { args: requested };
			const reply = await client.callTool(tool.name, call.args, {
				signal,
				timeoutMs: options.timeoutMs,
				onProgress: (progress) => {
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					const text = visibleControls(progress.message ?? `Progress ${progress.progress}${total}`);
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			const result = call.review ? call.review(reply) : reply;
			return options.presentation
				? options.presentation.convertResult(result, ctx)
				: convertMcpResult(server, tool.name, result);
		},
	};
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
export function createMcpToolRenderers(label: string): McpToolRenderers {
	return {
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(hostRender().formatToolCallWithArgs(label, args, theme, context.expanded));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const output = hostRender().getTextOutput(result, context.showImages).trim();
			if (!output) return component;
			const color = context.isError ? "error" : "toolOutput";
			const styled = output
				.replace(/\t/g, "   ")
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) =>
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${hostUi().keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			return component;
		},
	};
}
