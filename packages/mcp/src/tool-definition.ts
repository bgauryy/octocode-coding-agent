import { toolProgressText, type ToolDisplay } from "@octocodeai/octocode-contracts";
import { visibleControls } from "../../common/src/sanitize.ts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema } from "typebox";
import type { CallToolResult, Tool as McpTool } from "./client/index.ts";
import type { McpContext, McpToolDefinition, McpToolNamespace, McpToolRenderers } from "./host/types.ts";
import type { McpExposure } from "./config.ts";
import { deferredParameters } from "./deferred-schema.ts";
import { declaredExposure } from "./exposure.ts";
import { firstSentence, thinParameters } from "./presentation/declaration.ts";
import { envelopeHint, queriesCap } from "./presentation/validation-hint.ts";
import { renderMcpCall } from "./presentation/call-row.ts";
import { renderMcpResult } from "./presentation/result-row.ts";
import {
	type McpToolCaller,
	type McpToolDetails,
	convertMcpResult,
	createMcpResultSchema,
	toParameters,
} from "./tools.ts";

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

/**
 * The call preparation of a definition built here, for MCP's own other call paths (hooks): the same `prepareCall` and
 * `review` the model's calls pass through. A symbol keeps it off the public `McpToolDefinition` type and survives the
 * spread copies the registry and the host make.
 */
const PREPARE_CALL = Symbol("octocode.mcp.prepareCall");
type PrepareCall = (args: Record<string, unknown>, ctx: McpContext) => Promise<PreparedMcpCall>;

/** The preparation of a registered definition, or undefined when it was not built by `createMcpToolDefinition`. */
export function preparedCallOf(definition: object): PrepareCall | undefined {
	return (definition as { [PREPARE_CALL]?: PrepareCall })[PREPARE_CALL];
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
	compact?: {
		signature: () => string | undefined;
		summary?: string;
		/**
		 * No block of the prompt describes the tool (a deferred tool in `declared` mode): the declaration carries the
		 * server's whole description, and a failed validation shows the server's input schema.
		 */
		whole?: boolean;
		/** The tool is deferred: its declared parameters remember the server's input schema (`deferredParameters`). */
		deferred?: boolean;
	};
}

export function createMcpToolDefinition(options: McpToolDefinitionOptions): McpToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title;
	const label = options.presentation?.label ?? `${server}/${tool.name}`;
	const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
	const inputSchema = toParameters(tool.inputSchema);
	const { compact } = options;
	const prepare: PrepareCall = async (args, ctx) => (await options.presentation?.prepareCall?.(args, ctx)) ?? { args };
	const definition: McpToolDefinition<TSchema, McpToolDetails> = {
		name: options.name,
		label,
		// Providers declare input schemas; include the server's output contract in the same cached tool description.
		// A thin declaration leaves both to the typed signature, whose return type is the output schema.
		description: compact
			? compact.whole
				? description
				: (compact.summary ?? firstSentence(description))
			: tool.outputSchema
				? `${description}\n\nServer result schema:\n${JSON.stringify(tool.outputSchema)}`
				: description,
		parameters: compact
			? compact.deferred
				? deferredParameters(thinParameters(inputSchema), tool.inputSchema)
				: thinParameters(inputSchema)
			: inputSchema,
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
				block
					? `Expected signature (TypeScript):\n${block}`
					: compact?.whole
						? `Input schema (JSON Schema):\n${JSON.stringify(tool.inputSchema)}`
						: "",
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
		// An aborted call settles through its client within the connection's own timeout: wait that long, not the loop's default.
		abortGraceMs: options.timeoutMs,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const client = await options.getClient();
			const requested = (params ?? {}) as Record<string, unknown>;
			const call = await prepare(requested, ctx);
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
	return Object.assign(definition, { [PREPARE_CALL]: prepare });
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
		renderCall: renderMcpCall(label),
		renderResult: renderMcpResult,
	};
}
