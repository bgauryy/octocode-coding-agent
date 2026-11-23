import { MAX_ECHOED_ARGUMENTS_CHARS } from "@octocodeai/octocode-ai";
import { toolProgressText, type ToolDisplay } from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { liftedProperties } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema } from "typebox";
import type { CallToolResult, Tool as McpTool } from "./client/index.ts";
import { createOutputChecker } from "./client/output-check.ts";
import { hostCalls } from "./host.ts";
import type { McpContext, McpToolDefinition, McpToolNamespace, McpToolRenderers } from "./host/types.ts";
import type { McpExposure } from "./config.ts";
import { deferredParameters } from "./deferred-schema.ts";
import { declaredExposure } from "./exposure.ts";
import { firstSentence, thinParameters } from "./presentation/declaration.ts";
import { correctedCalls } from "./presentation/repeat-echo.ts";
import { envelopeHint, queriesCap, siblingHint } from "./presentation/validation-hint.ts";
import { labelParts, renderMcpCall } from "./presentation/call-row.ts";
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
	 * Declare the tool as a thin stub: the description's first sentence and an open input object. The
	 * model reads the tool's description and schema (a typed signature, or the JSON Schema in plain form) in its server's block of the system prompt; calls are validated against the
	 * server's own input schema, and a failed validation shows `signature()`.
	 */
	compact?: {
		signature: () => string | undefined;
		/**
		 * No block of the prompt describes the tool (a deferred tool in `declared` mode): the declaration carries the
		 * server's whole description, and a failed validation shows the server's input schema.
		 */
		whole?: boolean;
		/** The tool is deferred: its declared parameters remember the server's input schema (`deferredParameters`). */
		deferred?: boolean;
	};
}

/**
 * Whether a server's input schema refuses a top-level `reason`: it declares no such field (in its properties or any
 * root alternative's) and accepts no field it does not declare. Every native tool requires `reason`, and models carry
 * the habit into MCP calls, which such a schema then rejects.
 */
function refusesReason(inputSchema: Record<string, unknown>): boolean {
	if (Object.hasOwn(liftedProperties(inputSchema), "reason")) return false;
	const branches = inputSchema.anyOf ?? inputSchema.oneOf;
	const shapes = Array.isArray(branches) && branches.length > 0 ? branches : [inputSchema];
	const closed = (shape: unknown) =>
		isRecord(shape) &&
		(shape.additionalProperties === false || shape.unevaluatedProperties === false) &&
		shape.patternProperties === undefined;
	return closed(inputSchema) || shapes.every(closed);
}

export function createMcpToolDefinition(options: McpToolDefinitionOptions): McpToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title;
	const label = options.presentation?.label ?? `${server}/${tool.name}`;
	const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
	const inputSchema = toParameters(tool.inputSchema);
	const { compact } = options;
	const dropsReason = refusesReason(tool.inputSchema ?? {});
	const prepare: PrepareCall = async (args, ctx) => (await options.presentation?.prepareCall?.(args, ctx)) ?? { args };
	let lastFailure: string | undefined;
	// A definition is built from one tool list, so its checker lives exactly as long as the declared schema.
	const outputMismatch = tool.outputSchema ? createOutputChecker(tool.outputSchema) : undefined;
	const definition: McpToolDefinition<TSchema, McpToolDetails> = {
		name: options.name,
		label,
		// Providers declare input schemas; include the server's output contract in the same cached tool description.
		// A thin declaration leaves both to the typed signature, whose return type is the output schema.
		description: compact
			? compact.whole
				? description
				: firstSentence(description)
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
		validationHint: (failure) => {
			const { envelope, properties, arguments: sent, unexpected } = failure;
			// The same failing call twice in a row also gets the corrected call, built from what the model sent.
			const signature = JSON.stringify(sent);
			const repeated = signature !== undefined && signature === lastFailure;
			lastFailure = signature && signature.length <= MAX_ECHOED_ARGUMENTS_CHARS ? signature : undefined;
			const echo = repeated ? correctedCalls(tool.inputSchema, failure) : undefined;
			const shape = envelope ? envelopeHint(options.name, tool.inputSchema) : undefined;
			if (shape && shape.length <= MAX_ECHOED_ARGUMENTS_CHARS) {
				const hint = siblingHint(tool.inputSchema, unexpected, shape);
				return echo ? `${hint}\n\n${echo}` : hint;
			}
			const fields = siblingHint(tool.inputSchema, unexpected);
			const block = compact?.signature();
			const cap = queriesCap(tool.inputSchema);
			const hints = [
				fields,
				cap === undefined ||
				cap <= 0 ||
				!isRecord(sent) ||
				!Array.isArray(sent.queries) ||
				sent.queries.length <= cap ||
				!properties.includes("queries")
					? ""
					: `queries holds at most ${cap}; split into calls of ${cap} or fewer, run them in the same turn.`,
				block
					? `Expected signature (TypeScript):\n${block}`
					: compact?.whole
						? `Input schema (JSON Schema):\n${JSON.stringify(tool.inputSchema)}`
						: "",
			].filter(Boolean);
			if (echo) hints.push(echo);
			return hints.length ? hints.join("\n\n") : undefined;
		},
		// The server owns its input: arguments are checked against its schema as the model sent them and reach the server
		// unchanged, with no field added, moved, converted or parsed. A call the schema rejects fails with its hint. The one
		// field dropped is a top-level string `reason` that the schema neither declares nor accepts (`refusesReason`).
		coerceArguments: false,
		...(dropsReason
			? {
					prepareArguments: (args: unknown) => {
						if (!isRecord(args) || typeof args.reason !== "string") return args;
						const { reason: _reason, ...rest } = args;
						return rest;
					},
				}
			: {}),
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
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requested = (params ?? {}) as Record<string, unknown>;
			const calls = hostCalls();
			if (!calls) return callServer(requested, signal, onUpdate, ctx);
			const summary = argumentSummary(requested);
			return calls.run(
				{
					tool: options.name,
					title: summary ? `${label} ${summary}` : label,
					...(typeof requested.reason === "string" && requested.reason.trim() ? { reason: requested.reason } : {}),
					signal,
					ctx,
				},
				(callSignal, foreground) =>
					callServer(requested, callSignal, (update) => foreground() && onUpdate?.(update), ctx),
			);
		},
	};
	async function callServer(
		requested: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: Parameters<McpToolDefinition<TSchema, McpToolDetails>["execute"]>[3],
		ctx: McpContext,
	): Promise<AgentToolResult<McpToolDetails>> {
		lastFailure = undefined;
		const client = await options.getClient();
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
		const converted = options.presentation
			? await options.presentation.convertResult(result, ctx)
			: await convertMcpResult(server, tool.name, result);
		// The result still reaches the model; the note says its structured part broke the server's declared contract.
		// A tool that declares an outputSchema must return structuredContent (MCP spec); leaving it out breaks that too.
		const mismatch =
			!outputMismatch || result.isError
				? undefined
				: result.structuredContent === undefined
					? "structuredContent is missing"
					: outputMismatch(result.structuredContent);
		return mismatch
			? {
					...converted,
					content: [
						...converted.content,
						{
							type: "text",
							text: `Note: structuredContent does not match the tool's outputSchema (${visibleControls(mismatch)}).`,
						},
					],
				}
			: converted;
	}
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
	const { title, server } = labelParts(label);
	return {
		display({ args, result, status }: { args: unknown; result?: AgentToolResult<McpToolDetails>; status: string }) {
			const summary = argumentSummary(args);
			const head: ToolDisplay = {
				title,
				...(summary ? { summary } : {}),
				...(server ? { meta: [server] } : {}),
				kind: "other",
				blocks: [],
			};
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
