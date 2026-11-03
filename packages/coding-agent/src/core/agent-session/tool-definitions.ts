/** The tool definition registry a session builds from built-in, SDK and extension tools. */

import { mcpNamespace } from "../../../../common/src/mcp-names.ts";
import { OCTOCODE_SERVER } from "../../../../mcp/src/presets/octocode/names.ts";
import type { RegisteredTool, ToolDefinition } from "../features/index.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo } from "../source-info.ts";
import type { ToolDefinitionEntry } from "./types.ts";

function normalizePromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

export interface ToolDefinitionRegistry {
	/** Extension and SDK tools that `--tools` and `--exclude-tools` keep. */
	allCustomTools: RegisteredTool[];
	definitions: Map<string, ToolDefinitionEntry>;
	promptSnippets: Map<string, string>;
	promptGuidelines: Map<string, string[]>;
}

/**
 * Collect the definitions of the allowed tools. Extension and SDK tools replace built-in tools of
 * the same name; native feature tools are listed as built-in.
 */
export function buildToolDefinitionRegistry(
	registeredTools: RegisteredTool[],
	customTools: ToolDefinition[],
	baseToolDefinitions: Map<string, ToolDefinition>,
	isAllowedTool: (name: string) => boolean,
): ToolDefinitionRegistry {
	const allCustomTools = [
		...registeredTools,
		...customTools.map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
				source: "sdk",
			}),
		})),
	].filter((tool) => isAllowedTool(tool.definition.name));
	const definitionRegistry = new Map<string, ToolDefinitionEntry>(
		Array.from(baseToolDefinitions.entries())
			.filter(([name]) => isAllowedTool(name))
			.map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
				},
			]),
	);
	for (const tool of allCustomTools) {
		definitionRegistry.set(tool.definition.name, {
			definition: tool.definition,
			sourceInfo:
				tool.sourceInfo.owner === "native"
					? createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${tool.definition.name}`, { source: "builtin" })
					: tool.sourceInfo,
		});
	}
	const promptSnippets = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const snippet = normalizePromptSnippet(definition.promptSnippet);
				return snippet ? ([definition.name, snippet] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string] => entry !== undefined),
	);
	const promptGuidelines = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const guidelines = normalizePromptGuidelines(definition.promptGuidelines);
				return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
	);
	return { allCustomTools, definitions: definitionRegistry, promptSnippets, promptGuidelines };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Tools every role is given in the same form, declared first and in this order. */
const ROLE_INVARIANT_TOOLS = ["bash", "file", "web", "mcp"];

/**
 * Tools whose presence or declaration depends on the role (a child may lack askUser or skill), declared last and in this
 * order.
 */
const ROLE_VARIANT_TOOLS = ["backlog", "steps", "archive", "askUser", "agent", "skill", "models", "compact"];

/** The research server's namespace: every role that has MCP tools has these, so they come before other servers' tools. */
const SHARED_MCP_NAMESPACE = mcpNamespace(OCTOCODE_SERVER);

const rankIn = (list: readonly string[], name: string) => {
	const index = list.indexOf(name);
	return index < 0 ? undefined : index;
};

/**
 * The order tools are declared in, so that a parent and its children declare the same bytes for as long as possible
 * (the tool declarations lead the cached prompt prefix): role-invariant tools in a fixed order, then other tools in the
 * given order, then MCP tools (namespace `mcp__<server>`) sorted by namespace, the research server first, and name, then
 * role-variant tools. MCP registration and activation order follows connection timing, which would otherwise change the
 * declared tools, and so the cached prefix, between sessions of one configuration.
 */
export function orderToolNames(names: Iterable<string>, namespaceOf: (name: string) => string | undefined): string[] {
	const first: Array<{ name: string; rank: number }> = [];
	const last: Array<{ name: string; rank: number }> = [];
	const others: string[] = [];
	const mcp: Array<{ name: string; namespace: string }> = [];
	for (const name of new Set(names)) {
		const invariant = rankIn(ROLE_INVARIANT_TOOLS, name);
		const variant = rankIn(ROLE_VARIANT_TOOLS, name);
		const namespace = namespaceOf(name);
		if (invariant !== undefined) first.push({ name, rank: invariant });
		else if (variant !== undefined) last.push({ name, rank: variant });
		else if (namespace?.startsWith("mcp__")) mcp.push({ name, namespace });
		else others.push(name);
	}
	const shared = (namespace: string) => (namespace === SHARED_MCP_NAMESPACE ? 0 : 1);
	mcp.sort(
		(a, b) =>
			shared(a.namespace) - shared(b.namespace) || compareText(a.namespace, b.namespace) || compareText(a.name, b.name),
	);
	const byRank = (a: { rank: number }, b: { rank: number }) => a.rank - b.rank;
	return [
		...first.sort(byRank).map((tool) => tool.name),
		...others,
		...mcp.map((tool) => tool.name),
		...last.sort(byRank).map((tool) => tool.name),
	];
}
