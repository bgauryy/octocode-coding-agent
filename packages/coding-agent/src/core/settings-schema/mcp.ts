import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** How the cached system prompt describes MCP tools (`packages/mcp/src/presentation/`). */
export const McpSettingsProperties = {
	mcpPresentation: Type.Optional(
		Type.Union([Type.Literal("compact"), Type.Literal("json")], {
			description:
				'How the cached system prompt describes MCP tools: every enabled server\'s instructions and each enabled tool\'s description and schema, in one block per server. "compact" writes them as a generated TypeScript file (a tool it cannot express faithfully is described in plain form); "json" describes every tool in plain form, as the server sent it. Provider declarations are thin either way: a one-line trigger and the top-level field types, with calls validated against the server\'s own JSON Schema.',
			default: SETTINGS_DEFAULTS.mcpPresentation,
		}),
	),
	mcpExposure: Type.Optional(
		Type.Union([Type.Literal("direct"), Type.Literal("deferred"), Type.String({ pattern: "^auto:[0-9]+$" })], {
			description:
				'How much of each MCP tool the cached system prompt carries, for tools whose server sets no `exposure` (a server\'s or tool\'s own `exposure` wins). "direct": the full description and schema. "deferred": the server\'s purpose and one trigger line per tool; the agent reads the full upstream text with the `mcp` tool when it needs it, as a tool result, so the cached prefix never changes. "auto:<bytes>": servers stay direct, in name order, while their direct text fits within that many bytes, and are deferred past it. Tools stay declared and validated against the server\'s full schema either way, and nothing is deferred for an agent without the `mcp` tool.',
			default: SETTINGS_DEFAULTS.mcpExposure,
		}),
	),
};
