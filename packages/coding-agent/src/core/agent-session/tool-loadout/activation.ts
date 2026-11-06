import type { ToolDefinition, ToolExposure, ToolInfo } from "../../features/index.ts";
import type { ToolDefinitionEntry } from "../types.ts";

/** The public description of a registered tool. */
export function toToolInfo({ definition, sourceInfo }: ToolDefinitionEntry, exposure: ToolExposure): ToolInfo {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
		promptGuidelines: definition.promptGuidelines,
		exposure,
		...(definition.namespace ? { namespace: definition.namespace } : {}),
		...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
		sourceInfo,
	};
}

export interface ActivationInput {
	/** The `--tools` matcher, when an allowlist is set. */
	allowedTools?: (name: string) => boolean;
	/** The caller named the active tools, so nothing is added on registration. */
	explicitActiveNames: boolean;
	includeAllExtensionTools: boolean;
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
			// Naming or matching a tool activates it even when it is not active by default.
			if (input.allowedTools(name) && input.isDeclarable(name) && !input.deselected.has(name)) added.push(name);
		}
	} else if (input.includeAllExtensionTools) {
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
