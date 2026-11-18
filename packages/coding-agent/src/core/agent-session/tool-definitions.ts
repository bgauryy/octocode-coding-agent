/** The tool definition registry a session builds from built-in, SDK and feature tools. */

import { currentToolRoles } from "../../../../mcp/src/api.ts";
import type { RegisteredTool, ToolDefinition } from "../features/index.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo } from "../source-info.ts";
import type { ToolDefinitionEntry } from "./types.ts";
import { ROLE_INVARIANT_TOOLS, ROLE_VARIANT_ORDER } from "../tool-roles.ts";

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
	/** Feature and SDK tools that `--tools` and `--exclude-tools` keep. */
	allCustomTools: RegisteredTool[];
	definitions: Map<string, ToolDefinitionEntry>;
	promptSnippets: Map<string, string>;
	promptGuidelines: Map<string, string[]>;
}

/**
 * Collect the definitions of the allowed tools. Feature and SDK tools replace built-in tools of
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
					? createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${tool.definition.name}`, {
							source: "builtin",
							owner: "native",
						})
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

const rankIn = (list: readonly string[], name: string) => {
	const index = list.indexOf(name);
	return index < 0 ? undefined : index;
};

/**
 * The order tools are declared in, so that sessions and children of one configuration declare the same bytes (the tool
 * declarations lead the cached prompt prefix): role-invariant tools in a fixed order, then other tools sorted by name, then MCP tools (namespace `mcp__<server>`) sorted by namespace and name, with servers whose entry gives tools
 * roles first (every agent that has MCP tools gets those), then role-variant tools (declared by `roleVariant`, in `ROLE_VARIANT_ORDER`, then by name). MCP registration and activation
 * order follows connection timing, which would otherwise change the declared tools, and so the cached prefix, between
 * sessions of one configuration. The benefit is stability across sessions and reuse between siblings of one profile,
 * and, through the breakpoint at `findToolCacheBoundary` (`tool-roles.ts`), between a parent and its children and between roles.
 */
export function orderToolNames(
	names: Iterable<string>,
	namespaceOf: (name: string) => string | undefined,
	isRoleVariant: (name: string) => boolean,
): string[] {
	const first: Array<{ name: string; rank: number }> = [];
	const last: Array<{ name: string; rank: number }> = [];
	const others: string[] = [];
	const mcp: Array<{ name: string; namespace: string }> = [];
	for (const name of new Set(names)) {
		const invariant = rankIn(ROLE_INVARIANT_TOOLS, name);
		const namespace = namespaceOf(name);
		if (invariant !== undefined) first.push({ name, rank: invariant });
		else if (isRoleVariant(name))
			last.push({ name, rank: rankIn(ROLE_VARIANT_ORDER, name) ?? ROLE_VARIANT_ORDER.length });
		else if (namespace?.startsWith("mcp__")) mcp.push({ name, namespace });
		else others.push(name);
	}
	const roled = new Set([...currentToolRoles().readOnly].map(namespaceOf));
	const shared = (namespace: string) => (roled.has(namespace) ? 0 : 1);
	mcp.sort(
		(a, b) =>
			shared(a.namespace) - shared(b.namespace) || compareText(a.namespace, b.namespace) || compareText(a.name, b.name),
	);
	const byRank = (a: { name: string; rank: number }, b: { name: string; rank: number }) =>
		a.rank - b.rank || compareText(a.name, b.name);
	return [
		...first.sort(byRank).map((tool) => tool.name),
		...others.sort(compareText),
		...mcp.map((tool) => tool.name),
		...last.sort(byRank).map((tool) => tool.name),
	];
}
