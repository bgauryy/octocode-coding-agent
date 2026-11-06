import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** How the cached system prompt describes MCP tools (`packages/mcp/src/presentation/`). */
export const McpSettingsProperties = {
	mcpPresentation: Type.Optional(
		Type.Union([Type.Literal("declared"), Type.Literal("compact"), Type.Literal("json")], {
			description:
				"How MCP tools reach the model. \"declared\": each tool's provider declaration carries the server's own description and full input JSON Schema, and the system prompt holds only each server's instructions. \"compact\": thin declarations (a one-line trigger and the top-level field types), with every enabled server's instructions and each tool's description and schema in one block of the system prompt, written as a generated TypeScript file (a tool it cannot express faithfully is described in plain form). \"json\": thin declarations, with that block in plain form, as the server sent it. Calls are validated against the server's own JSON Schema in every mode.",
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
