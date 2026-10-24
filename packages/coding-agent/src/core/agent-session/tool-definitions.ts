/** The tool definition registry a session builds from built-in, SDK and extension tools. */

import type { RegisteredTool, ToolDefinition } from "../extensions/index.ts";
import { NATIVE_FEATURE_PATH } from "../native-tools.ts";
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
				tool.sourceInfo.path === NATIVE_FEATURE_PATH
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

/**
 * The order tools are declared in: the given order, except that MCP tools (namespace `mcp__<server>`) come last,
 * sorted by namespace and then name. Their registration and activation order follows connection timing, which
 * would otherwise change the declared tools, and so the cached prompt prefix, between sessions of one configuration.
 */
export function orderToolNames(names: Iterable<string>, namespaceOf: (name: string) => string | undefined): string[] {
	const others: string[] = [];
	const mcp: Array<{ name: string; namespace: string }> = [];
	for (const name of new Set(names)) {
		const namespace = namespaceOf(name);
		if (namespace?.startsWith("mcp__")) mcp.push({ name, namespace });
		else others.push(name);
	}
	mcp.sort((a, b) => compareText(a.namespace, b.namespace) || compareText(a.name, b.name));
	return [...others, ...mcp.map((tool) => tool.name)];
}
