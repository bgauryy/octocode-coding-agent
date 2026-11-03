import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** How the cached system prompt describes MCP tools (`packages/mcp/src/presentation/`, `contract-tiers.ts`). */
export const McpSettingsProperties = {
	mcpPresentation: Type.Optional(
		Type.Union([Type.Literal("compact"), Type.Literal("json")], {
			description:
				'How the cached system prompt describes MCP tools: every enabled server\'s instructions and each enabled tool\'s description and schema, in one block per server. "compact" writes them as a generated TypeScript file (a tool it cannot express faithfully is described in plain form); "json" describes every tool in plain form, as the server sent it. Provider declarations are thin either way: a one-line trigger and the top-level field types, with calls validated against the server\'s own JSON Schema.',
			default: SETTINGS_DEFAULTS.mcpPresentation,
		}),
	),
	mcpContractTiers: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("off")], {
			description:
				'Where a declared MCP tool\'s contract (description and schemas) lives. "auto" keeps the tools this workspace uses in the cached `mcps` block and names the rest on one line, read on demand with the `mcp` tool; the split comes from usage frozen per workspace, agent profile and day, so it does not change within a session or a day. "off" describes every tool in full. A server\'s `contract` and `toolContract` settings in mcp.json override it.',
			default: SETTINGS_DEFAULTS.mcpContractTiers,
		}),
	),
};
