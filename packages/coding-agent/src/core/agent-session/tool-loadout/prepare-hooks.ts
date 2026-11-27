import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ToolLoadout } from "../../features/index.ts";
import type { ToolDefinitionEntry } from "../types.ts";

/**
 * Runs the `prepareLoadout` hooks of the active tools: the declared descriptions they change and the declarations
 * they hide from requests; `makeLoadout` runs only when a hook exists. A throwing hook is reported through `onError` and skipped.
 */
export function runPrepareLoadoutHooks(
	tools: AgentTool[],
	hooks: ToolDefinitionEntry[],
	makeLoadout: () => ToolLoadout,
	onError: (entry: ToolDefinitionEntry, error: string, stack: string | undefined) => void,
): { declared: AgentTool[]; hidden: Set<string> } {
	const hidden = new Set<string>();
	if (hooks.length === 0) return { declared: tools, hidden };
	const loadout = makeLoadout();
	const descriptions = new Map<string, string>();
	for (const entry of hooks) {
		try {
			const changes = entry.definition.prepareLoadout?.(loadout);
			for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
				descriptions.set(name, description);
			}
			for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
		} catch (error) {
			onError(entry, errorMessage(error), error instanceof Error ? error.stack : undefined);
		}
	}
	const declared = tools.map((tool) => {
		const description = descriptions.get(tool.name);
		return description === undefined ? tool : { ...tool, description };
	});
	return { declared, hidden };
}
