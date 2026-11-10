import {
	toolProgressFraction,
	toolProgressText,
	type ApplicationToolProgress,
	type ToolDisplay,
} from "@octocodeai/octocode-contracts";
import { Container, Spacer, Text, VisualLinePreview } from "@octocodeai/octocode-tui";
import { visibleControls } from "../../common/src/sanitize.ts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema } from "typebox";
import type { CallToolResult, Tool as McpTool } from "./client/index.ts";
import type { McpContext, McpToolDefinition, McpToolNamespace, McpToolRenderers } from "./host/types.ts";
import { hostRender, hostUi } from "./host.ts";
import type { McpExposure } from "./config.ts";
import { declaredExposure } from "./exposure.ts";
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
const METER_CELLS = 20;

/** `██████░░░░ 3/10 (30%) · message`; without a known total only the text. */
function progressMeter(progress: ApplicationToolProgress): string {
	const fraction = toolProgressFraction(progress);
	const text = visibleControls(toolProgressText(progress)).replace(/\s+/g, " ");
	if (fraction === undefined) return text;
	const filled = Math.round(fraction * METER_CELLS);
	return `${"█".repeat(filled)}${"░".repeat(METER_CELLS - filled)} ${text}`;
}

interface PreparedMcpCall {
	args: Record<string, unknown>;
	/** Applied to the server's result before `convertResult`. */
	review?: (result: CallToolResult) => CallToolResult;
}

interface McpToolPresentation extends McpToolRenderers {
	label?: string;
	outputSchema?: TSchema;
	/**
	 * Prepares the server call and may review the raw result. The arguments are the server's input: only a safety boundary
	 * may change them (the browser's network filter), never their shape.
	 */
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
	 * model reads the tool's description and schema (a typed signature, or the JSON Schema in plain form) in its server's block of the system prompt; calls are validated against the
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
		...(tool.annotations?.destructiveHint === true ? { annotations: { destructiveHint: true as const } } : {}),
		...(compact ? { validationParameters: inputSchema } : {}),
		// Shown after a failed validation, for every tool: a failure at the top level (a native `reason`, `type` or
		// `timeout` sent to a server that does not declare it) names the accepted call shape; any other names the working
		// next step for an over-long `queries` batch, and a compact tool adds its typed signature.
		validationHint: ({ envelope, properties }) => {
			const shape = envelope ? envelopeHint(options.name, tool.inputSchema) : undefined;
			if (shape) return shape;
			const block = compact?.signature();
			const cap = queriesCap(tool.inputSchema);
			const hints = [
				cap === undefined || !properties.includes("queries")
					? ""
					: `queries holds at most ${cap}; split into calls of ${cap} or fewer, run them in the same turn.`,
				block ? `Expected signature (TypeScript):\n${block}` : "",
			].filter(Boolean);
			return hints.length ? hints.join("\n\n") : undefined;
		},
		// The server owns its input: arguments are checked against its schema as the model sent them and reach the server
		// unchanged, with no field added, dropped, moved, converted or parsed. A call the schema rejects fails with its hint.
		coerceArguments: false,
		...(options.presentation
			? options.presentation.outputSchema
				? { outputSchema: options.presentation.outputSchema }
				: {}
			: { outputSchema: createMcpResultSchema(tool.outputSchema) }),
		exposure: declaredExposure(options.exposure),
		...(options.defaultActive === false ? { defaultActive: false } : {}),
		namespace: options.namespace,
		...(({ renderCall, renderResult }) => ({ renderCall, renderResult }))(
			options.presentation ?? createMcpToolRenderers(label),
		),
		// A preset that draws its own rows still gets the generic display for other surfaces.
		display: options.presentation?.display ?? createMcpToolRenderers(label).display,
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
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { server, tool: tool.name },
						progress: {
							progress: progress.progress,
							...(progress.total === undefined ? {} : { total: progress.total }),
							...(progress.message ? { message: visibleControls(progress.message) } : {}),
						},
					});
				},
			});
			const result = call.review ? call.review(reply) : reply;
			return options.presentation
				? options.presentation.convertResult(result, ctx)
				: convertMcpResult(server, tool.name, result);
		},
	};
}

/** `key=value` pairs of a call's arguments, for its header: the server owns the input, so no field is singled out. */
function argumentSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args as Record<string, unknown>)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" ")
		.replace(/\s+/g, " ")
		.slice(0, 200);
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
export function createMcpToolRenderers(label: string): McpToolRenderers {
	return {
		display({ args, result, status }: { args: unknown; result?: AgentToolResult<McpToolDetails>; status: string }) {
			const summary = argumentSummary(args);
			const head: ToolDisplay = { title: label, ...(summary ? { summary } : {}), kind: "other", blocks: [] };
			if (!result) return head;
			const text = result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n")
				.trim();
			const spill = result.details?.fullOutputPath;
			if (status === "running" && result.progress)
				return { ...head, outcome: { text: toolProgressText(result.progress), tone: "muted" }, blocks: [] };
			const [first = "", ...rest] = text.split("\n");
			return {
				...head,
				...(status === "failed" ? { outcome: { text: first, tone: "error" as const } } : {}),
				blocks: [
					...((status === "failed" ? rest.join("\n") : text).trim()
						? [
								{
									type: "text" as const,
									text: status === "failed" ? rest.join("\n") : text,
									...(status === "running" ? { preview: "tail" as const } : {}),
								},
							]
						: []),
					...(spill
						? [{ type: "path" as const, text: `full output: ${spill}`, label: "full output", path: spill }]
						: []),
				],
			};
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(hostRender().formatToolCallWithArgs(label, args, theme, context.expanded));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			// A running call that reports progress shows a meter; its text update says the same in words.
			if (context.isPartial && result.progress) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("muted", progressMeter(result.progress)), 0, 0));
				return component;
			}
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
