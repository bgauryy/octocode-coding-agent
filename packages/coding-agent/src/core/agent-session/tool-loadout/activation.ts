import type { ToolDefinition, ToolInfo } from "../../features/index.ts";
import type { ToolDefinitionEntry } from "../types.ts";

/** The selected registry, with the descriptions the active loadout serves and the tools available on demand. */
export function toolInfos(
	entries: Iterable<ToolDefinitionEntry>,
	active: readonly Pick<ToolDefinition, "name" | "description" | "parameters">[],
	activatable: (name: string) => boolean,
): ToolInfo[] {
	const declared = new Map(active.map((tool) => [tool.name, tool]));
	return Array.from(entries, ({ definition, sourceInfo }) => {
		const tool = declared.get(definition.name) ?? definition;
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
			promptGuidelines: definition.promptGuidelines,
			exposure: definition.exposure ?? "direct",
			...(definition.onDemand && activatable(tool.name) ? { onDemand: true } : {}),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
		};
	});
}

export interface ActivationInput {
	/** The `--tools` matcher, when an allowlist is set. */
	allowedTools?: (name: string) => boolean;
	/** The allowlist's entries: only one that is a tool's exact name, not a pattern, activates an on-demand tool. */
	allowedEntries?: readonly string[];
	/** Whether the tool is registered undeclared until first use (`ToolDefinition.onDemand`). */
	isOnDemand: (name: string) => boolean;
	/** The caller named the active tools, so nothing is added on registration. */
	explicitActiveNames: boolean;
	includeAllFeatureTools: boolean;
	registered: Iterable<string>;
	customTools: { definition: ToolDefinition; sourceInfo: { owner?: string } }[];
	previousActivated: ReadonlySet<string>;
	deselected: ReadonlySet<string>;
	isDeclarable: (name: string) => boolean;
	isActivatedOnRegistration: (name: string) => boolean;
}

/** Tools a refresh activates beyond the previously active ones: those an allowlist names, or new ones that activate on registration. */
export function toolsToActivate(input: ActivationInput): string[] {
	const added: string[] = [];
	if (input.allowedTools) {
		for (const name of input.registered) {
			// Naming or matching a tool activates it even when it is not active by default. An on-demand tool only by its
			// exact name: a pattern (a role's `mcp__browser__*`) leaves such a tool undeclared until its first use.
			if (input.isOnDemand(name) && !input.allowedEntries?.includes(name)) continue;
			if (input.allowedTools(name) && input.isDeclarable(name) && !input.deselected.has(name)) added.push(name);
		}
	} else if (input.includeAllFeatureTools) {
		for (const { definition, sourceInfo } of input.customTools) {
			if (sourceInfo.owner !== "native" && input.isActivatedOnRegistration(definition.name))
				added.push(definition.name);
		}
	} else if (!input.explicitActiveNames) {
		for (const name of input.registered) {
			const known = input.previousActivated.has(name) || input.deselected.has(name);
			if (!known && input.isActivatedOnRegistration(name)) added.push(name);
		}
	}
	return added;
}

type CompanionsOf = (name: string) => readonly string[] | undefined;

/** The companions of every tool the selection keeps (`ToolDefinition.companionTools`): registered whatever it says. */
export function companionFloor(
	definitions: Iterable<Pick<ToolDefinition, "name" | "companionTools">>,
	isSelected: (name: string) => boolean,
): Set<string> {
	const floor = new Set<string>();
	for (const { name, companionTools } of definitions)
		if (companionTools && isSelected(name)) for (const companion of companionTools) floor.add(companion);
	return floor;
}

/** `names` with the companions of each name added after it, once. */
export function withCompanions(names: readonly string[], companionsOf: CompanionsOf): string[] {
	const result = new Set(names);
	for (const name of names) for (const companion of companionsOf(name) ?? []) result.add(companion);
	return [...result];
}
