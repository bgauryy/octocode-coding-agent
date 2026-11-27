import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** How the cached system prompt describes MCP tools (`packages/mcp/src/presentation/`). */
export const McpSettingsProperties = {
	mcpPresentation: Type.Optional(
		Type.Union([Type.Literal("declared"), Type.Literal("compact"), Type.Literal("json")], {
			description:
				'How MCP contracts reach the model. In "declared" mode a direct tool carries the full server schema in its declaration. With the default "usage" exposure, an agent with the mcp tool sees unpinned MCP tools as deferred. Each starts with the server description and thin parameters. The agent can load its full contract with mcp. In "compact" and "json" modes declarations are thin and direct tools have their contracts in the system prompt as TypeScript or JSON. Every mode validates calls against the full server input schema.',
			default: SETTINGS_DEFAULTS.mcpPresentation,
		}),
	),
	mcpExposure: Type.Optional(
		Type.Union(
			[
				Type.Literal("direct"),
				Type.Literal("deferred"),
				Type.Literal("recent"),
				Type.Literal("usage"),
				Type.String({ pattern: "^auto:[0-9]+$" }),
			],
			{
				description:
					'Initial exposure of MCP tools without a tool or server override. "usage" starts open tools deferred and can promote on-demand tools to thin declarations within mcpPromotedBytes. "recent" uses calls in this working directory in the last 24 hours to select direct tools. "direct" and "deferred" set a fixed default. "auto:<bytes>" keeps servers direct in name order while their contracts fit the budget. An agent without the mcp tool gets direct exposure.',
				default: SETTINGS_DEFAULTS.mcpExposure,
			},
		),
	),
	mcpPromotedBytes: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				'Under mcpExposure "usage": the bytes, per role group (main or subagent), that promoted on-demand tools may add to the tool list at the start of a session, most used first; a promoted tool that does not fit stays on demand. 0 keeps every on-demand tool on demand. Bytes, not a share of the context window, so changing models never changes the tool list.',
			default: SETTINGS_DEFAULTS.mcpPromotedBytes,
		}),
	),
	nativeToolExposure: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.Literal("direct"), Type.Literal("deferred")]), {
			description:
				'Pins a deferrable native tool (archive, models, backlogPlan, configuration; memory and wait under "usage" only): "direct" always declares its full schema, "deferred" declares its description and top-level fields (types, the few values a field allows, required fields) only. Unpinned, the tool is deferred under mcpExposure "recent" until this working directory calls it, and always under "usage"; it is direct otherwise. A deferred tool stays callable, and a call its schema rejects returns the schema. Where the model adds tools after the cached prompt and the agent has the `mcp` tool, an unpinned archive or models (and memory in a subagent) that would be deferred is on demand instead, unless the "usage" promotion snapshot names it: listed in the prompt, declared after its first call or a read with the `mcp` tool.',
		}),
	),
};
