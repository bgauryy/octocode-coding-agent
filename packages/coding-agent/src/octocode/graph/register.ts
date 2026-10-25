import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { errorMessage } from "../../utils/guards.ts";
import { graphBinary, graphSchema, GRAPH_TOOLS, runGraphCli } from "./cli.ts";

/** The CLI owns descriptions, validation, grammar support and execution. */
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
		pi.registerTool({
			name,
			label: name === "graphBuild" ? "Build graph" : "Query graph",
			description: schema.description,
			parameters: Type.Object(
				{
					request: Type.Unsafe<Record<string, unknown>>({
						...schema.inputSchema,
						description:
							"Octocode CLI input. Use queries for a new question; copy next.*.input here to continue evidence, or related[].input to start its suggested question.",
					}),
				},
				{ $defs: schema.inputSchema.$defs },
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
