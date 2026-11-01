import {
	type CompactServerInput,
	type DescriptionOverrides,
	parsePresetOverrides,
	presetOverridesFor,
} from "../../compact/index.ts";
import data from "./compact-overrides.json" with { type: "json" };

const parsed = parsePresetOverrides(data);

/**
 * `lspSearch` names the language servers installed where the server runs ("Servers found here: ts/js, py."), so its
 * hash would differ from host to host. The shipped entry is written for this list; any host's list is matched to it,
 * and its own list replaces the shipped one in the override text.
 */
const SERVERS = /Servers found here: ([^.<]*)\./;
const SHIPPED_SERVERS = "ts/js, py, c/c++";

function withShippedServers(input: CompactServerInput): { input: CompactServerInput; servers: Map<string, string> } {
	const servers = new Map<string, string>();
	const tools = input.tools.map((tool) => {
		const found = SERVERS.exec(tool.description ?? "");
		if (!found?.[1]) return tool;
		servers.set(tool.name, found[1]);
		return { ...tool, description: tool.description?.replace(SERVERS, `Servers found here: ${SHIPPED_SERVERS}.`) };
	});
	return { input: { ...input, tools }, servers };
}

/**
 * Description overrides and triggers for the generated file of the Octocode research server, written with the
 * `octocode-context-optimization` skill. Each tool's entries carry the hash of the tool they describe, so a server release that
 * changes a tool drops only that tool's entries; the skill rewrites them. Write them from a catalog read where only
 * the ts/js, py and c/c++ servers are installed (an empty home).
 */
export function octocodeCompactOverrides(input: CompactServerInput): DescriptionOverrides | undefined {
	if (!("overrides" in parsed)) return undefined;
	const { input: shipped, servers } = withShippedServers(input);
	const overrides = presetOverridesFor(parsed.overrides, shipped);
	if (!overrides?.tools || servers.size === 0) return overrides;
	const tools = { ...overrides.tools };
	for (const [name, list] of servers)
		if (tools[name] !== undefined)
			tools[name] = tools[name].replace(`Servers: ${SHIPPED_SERVERS}.`, `Servers: ${list}.`);
	return { ...overrides, tools };
}
