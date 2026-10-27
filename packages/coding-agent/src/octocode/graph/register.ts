import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { errorMessage } from "../../utils/guards.ts";
import { graphBinary, graphSchema, GRAPH_TOOLS, runGraphCli } from "./cli.ts";

/** Size and range keywords: the CLI enforces them on every request, so the declared schema keeps only shape. */
const BOUNDS = new Set([
	"maxLength",
	"minLength",
	"maxItems",
	"minItems",
	"maximum",
	"minimum",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"pattern",
	"maxProperties",
	"minProperties",
]);

/**
 * The schema without size or range bounds. A call that breaks a declared bound is refused before it runs and echoes its
 * arguments back; the CLI's own validation reports the same limit with recovery hints instead. A property that happens
 * to be named like a bound (an object schema, not a number or string) stays.
 */
export function shapeOnly<T>(schema: T): T {
	if (Array.isArray(schema)) return schema.map(shapeOnly) as T;
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key, value]) => !BOUNDS.has(key) || (typeof value === "object" && value !== null))
			.map(([key, value]) => [key, shapeOnly(value)]),
	) as T;
}

/**
 * The CLI owns descriptions, validation, grammar support and execution. Both tools are deferred: their contracts cost
 * about 12k characters, so they load through tool search when a dependency, caller or impact question needs them.
 */
export function registerGraphTools(pi: ExtensionAPI): void {
	let binary: string;
	let schemas: ReturnType<typeof graphSchema>[];
	try {
		binary = graphBinary();
		schemas = GRAPH_TOOLS.map((name) => graphSchema(binary, name, process.cwd()));
	} catch (error) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`Graph tools unavailable: ${errorMessage(error)}`, "warning");
		});
		return;
	}
	for (const [index, name] of GRAPH_TOOLS.entries()) {
		const schema = schemas[index];
		const { $defs, ...requestSchema } = shapeOnly(schema.inputSchema);
		pi.registerTool({
			name,
			label: name === "graphBuild" ? "Build graph" : "Query graph",
			description: schema.description,
			exposure: "deferred",
			parameters: Type.Object(
				{
					request: Type.Unsafe<Record<string, unknown>>({
						...requestSchema,
						description:
							"Octocode CLI input. Use queries for a new question. Copy responsePagination.next.input or next.*.input here to finish evidence; related[].input starts its suggested question.",
					}),
				},
				{ $defs, additionalProperties: false },
			),
			async execute(_id, { request }, signal, _onUpdate, ctx) {
				const result = await runGraphCli(binary, name, request, ctx.cwd, ctx.isProjectTrusted(), signal);
				return {
					content: [{ type: "text", text: fenceUntrusted(`Octocode ${name}`, JSON.stringify(result.output)) }],
					details: result.output,
					isError: result.isError,
				};
			},
		});
	}
}
