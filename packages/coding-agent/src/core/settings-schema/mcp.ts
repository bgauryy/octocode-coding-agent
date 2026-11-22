import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** How the cached system prompt describes MCP tools (`packages/mcp/src/presentation/`). */
export const McpSettingsProperties = {
	mcpPresentation: Type.Optional(
		Type.Union([Type.Literal("declared"), Type.Literal("compact"), Type.Literal("json")], {
			description:
				"How MCP tools reach the model. \"declared\": each tool's provider declaration carries the server's own description and full input JSON Schema, and the system prompt holds only each server's instructions. \"compact\": thin declarations (a one-line trigger and the field names and types, without descriptions), with every enabled server's instructions and each tool's description and schema in one block of the system prompt, written as a generated TypeScript file (a tool it cannot express faithfully is described in plain form). \"json\": thin declarations, with that block in plain form, as the server sent it. Calls are validated against the server's own JSON Schema in every mode.",
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
					'How much of each MCP tool the cached system prompt carries, for tools whose server sets no `exposure` (a server\'s or tool\'s own `exposure` wins). "direct": the full description and schema. "deferred": the server\'s purpose and one trigger line per tool; the agent reads the full upstream text with the `mcp` tool when it needs it, as a tool result, so the cached prefix never changes. "recent": a tool this working directory called in the last 24 hours is direct, any other is deferred with its whole description, and the deferrable native tools (see nativeToolExposure) follow the same rule; the set is fixed when the session starts and a subagent uses the set of its parent. "usage" (the default): every tool is deferred with its whole description, its field names and types, the few values a field allows, list bounds and required fields, whether sessions use it or not; the promotion snapshot only decides whether a tool its server leaves on demand is declared that way from the session\'s start instead of after its first use. The snapshot names the tools that at least 10% of the last 7 days\' sessions with the same role (main or subagent) that offered them called or loaded, with 20 or more such sessions, or whose first calls the deferred schema often refused, kept while their declarations fit mcpPromotedBytes; a tool with fewer sessions keeps the exposure its configuration gives it. It is computed once per UTC day and installed version, and then fixed for the session, its resumptions and its subagents. "auto:<bytes>": servers stay direct, in name order, while their direct text fits within that many bytes, and are deferred past it. Tools stay declared and validated against the server\'s full schema either way, and nothing is deferred for an agent without the `mcp` tool.',
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
				'Pins a deferrable native tool (web, archive, models, backlogPlan, configuration; memory and wait under "usage" only): "direct" always declares its full schema, "deferred" declares its description and top-level fields (types, the few values a field allows, required fields) only. Unpinned, the tool is deferred under mcpExposure "recent" until this working directory calls it, and always under "usage"; it is direct otherwise. A deferred tool stays callable, and a call its schema rejects returns the schema. Where the model adds tools after the cached prompt and the agent has the `mcp` tool, an unpinned archive or models (and memory in a subagent) that would be deferred is on demand instead, unless the "usage" promotion snapshot names it: listed in the prompt, declared after its first call or a read with the `mcp` tool.',
		}),
	),
};
