import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { cachedGraphSchema, graphBinary, graphSchema, GRAPH_TOOLS, runGraphCli } from "./cli.ts";
import type { GraphSchema } from "./schema-cache.ts";
import { trimSchemaDefinitions } from "./schema-trim.ts";

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
function shapeOnly<T>(schema: T): T {
	if (Array.isArray(schema)) return schema.map(shapeOnly) as T;
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key, value]) => !BOUNDS.has(key) || (typeof value === "object" && value !== null))
			.map(([key, value]) => [key, shapeOnly(value)]),
	) as T;
}

/**
 * The CLI owns descriptions, validation, grammar support and execution. Both tools are declared directly; their
 * contracts (about 12k characters) sit in the cached tool declarations.
 */
export function registerGraphTools(api: ExtensionAPI): void | Promise<void> {
	const unavailable = (error: unknown) => {
		api.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`Graph tools unavailable: ${errorMessage(error)}`, "warning");
		});
	};
	let binary: string;
	let cached: (GraphSchema | undefined)[];
	try {
		binary = graphBinary();
		cached = GRAPH_TOOLS.map((name) => cachedGraphSchema(binary, name));
	} catch (error) {
		unavailable(error);
		return;
	}
	// A cached contract registers at once; only the first start after a new build asks the CLI, off the event loop.
	if (cached.every((schema) => schema !== undefined)) return declare(api, binary, cached);
	return Promise.all(GRAPH_TOOLS.map((name) => graphSchema(binary, name, process.cwd()))).then(
		(schemas) => declare(api, binary, schemas),
		unavailable,
	);
}

function declare(api: ExtensionAPI, binary: string, schemas: GraphSchema[]): void {
	for (const [index, name] of GRAPH_TOOLS.entries()) {
		const schema = schemas[index];
		const { $defs, ...requestSchema } = trimSchemaDefinitions(shapeOnly(schema.inputSchema));
		api.registerTool({
			name,
			label: name === "graphBuild" ? "Build graph" : "Query graph",
			description: schema.description,
			parameters: Type.Object(
				{
					request: Type.Unsafe<Record<string, unknown>>({
						...requestSchema,
						description:
							"queries: a new question. To finish evidence, paste responsePagination.next.input (or next.*.input); related[].input starts its suggested question.",
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
