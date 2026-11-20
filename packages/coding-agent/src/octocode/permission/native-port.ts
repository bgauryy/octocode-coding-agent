/**
 * The native tools as the `mcp` tool reads them (`server: "native"`): the deferred and undeclared ones by name with the
 * declaration each has when direct, and any tool the session declares in full, so asking for a declared tool's schema
 * is a plain read rather than a refusal. `native-deferral.ts` fills the maps as tools register.
 */

import type { McpNativeTools } from "../../../../mcp/src/api.ts";
import type { ToolDefinition } from "../../core/features/index.ts";
import { type Forms, undeclared } from "./native-forms.ts";

/** The latest forms of each deferrable tool by name, across feature loads: what the `mcp` tool reads. */
export const formsByName = new Map<string, Forms>();
/** The latest declaration of each native tool that is never deferred (`bash`, `file`, `agent`…), by name. */
export const coreDeclarations = new Map<string, { description: string; parameters: unknown }>();
/** The deferred tools read in full this session that are not yet declared in full (`redeclareLoadedNatives`). */
export const loadedNatives = new Set<string>();

/** The model read or called `name`: a deferred one is declared in full after the cache, an undeclared one is declared. */
export function markLoaded(name: string): void {
	const forms = formsByName.get(name);
	if (forms?.isDeferred) loadedNatives.add(name);
	// Reading an undeclared on-demand tool declares it from the next request on.
	if (forms && undeclared(name, forms)) {
		const active = forms.onDemand!.tools.getActive();
		forms.onDemand!.tools.setActive([...active, name]);
	}
}

const isThinOrUndeclared = (name: string, forms: Forms): boolean => forms.isDeferred || undeclared(name, forms);
const declaration = (tool: ToolDefinition) => ({ description: tool.description, parameters: tool.parameters });

/**
 * The deferred native tools as the `mcp` tool reads them: their names, and the description and input schema each
 * declares when direct. Reading one counts as a load and queues its full declaration (`redeclareLoadedNatives`).
 * `declared` reads a tool the session already declares in full, which changes nothing.
 */
export function nativeToolsPort(): McpNativeTools {
	return {
		deferred: () =>
			[...formsByName]
				.filter(([name, forms]) => isThinOrUndeclared(name, forms))
				.map(([name]) => name)
				.sort(),
		schema: (name) => {
			const forms = formsByName.get(name);
			return forms && isThinOrUndeclared(name, forms) ? declaration(forms.direct) : undefined;
		},
		declared: (name) => {
			const forms = formsByName.get(name);
			if (forms) return isThinOrUndeclared(name, forms) ? undefined : declaration(forms.direct);
			return coreDeclarations.get(name);
		},
		loaded: markLoaded,
	};
}
