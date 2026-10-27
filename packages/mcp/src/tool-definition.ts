import { Container, Spacer, Text } from "@octocodeai/octocode-tui";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema } from "typebox";
import type { CallToolResult, Tool as McpTool } from "./client/index.ts";
import type {
	ExtensionContext,
	ToolDefinition,
	ToolNamespace,
	ToolRenderers,
} from "../../coding-agent/src/core/extensions/types.ts";
import { formatToolCallWithArgs, getTextOutput, replaceTabs } from "../../coding-agent/src/core/tools/render-utils.ts";
import { keyHint } from "../../coding-agent/src/modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../coding-agent/src/modes/interactive/components/visual-truncate.ts";
import { visibleControls } from "../../coding-agent/src/octocode/shared/sanitize.ts";
import type { McpExposure } from "./config.ts";
import {
	type McpToolCaller,
	type McpToolDetails,
	convertMcpResult,
	createMcpResultSchema,
	toParameters,
	toToolExposure,
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
export interface PreparedMcpCall {
	args: Record<string, unknown>;
	/** Applied to the server's result before `convertResult`. */
	review?: (result: CallToolResult) => CallToolResult;
}

export interface McpToolPresentation extends ToolRenderers {
	label?: string;
	outputSchema?: TSchema;
	/** Rewrites the arguments just before the server call (the model-facing schema is unchanged) and may review the raw result. */
	prepareCall?: (args: Record<string, unknown>, ctx: ExtensionContext) => PreparedMcpCall | Promise<PreparedMcpCall>;
	convertResult: (result: CallToolResult, ctx: ExtensionContext) => Promise<AgentToolResult<McpToolDetails>>;
}

export interface McpToolDefinitionOptions {
	presentation?: McpToolPresentation;
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	namespace: ToolNamespace;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
}

export function createMcpToolDefinition(options: McpToolDefinitionOptions): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title;
	const label = options.presentation?.label ?? `${server}/${tool.name}`;
	const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
	return {
		name: options.name,
		label,
		// Providers declare input schemas; include the server's output contract in the same cached tool description.
		description: tool.outputSchema
			? `${description}\n\nServer result schema:\n${JSON.stringify(tool.outputSchema)}`
			: description,
		parameters: toParameters(tool.inputSchema),
		...(declaresReason(tool.inputSchema) ? {} : { prepareArguments: dropReason }),
		...(options.presentation
			? options.presentation.outputSchema
				? { outputSchema: options.presentation.outputSchema }
				: {}
			: { outputSchema: createMcpResultSchema(tool.outputSchema) }),
		exposure: toToolExposure(options.exposure),
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
export function createMcpToolRenderers(label: string): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatToolCallWithArgs(label, args, theme, context.expanded));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const output = getTextOutput(result, context.showImages).trim();
			if (!output) return component;
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
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
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			return component;
		},
	};
}
