import { builtinPresets } from "../../../mcp/src/presets/index.ts";
import { resolveToolRoles } from "../../../mcp/src/roles.ts";

/** The roles of every server Octocode registers by default: the one place a test learns which tools the research server reads and searches with. */
export const builtinRoles = () =>
	resolveToolRoles(
		builtinPresets().flatMap(({ name, config }) => (config ? [{ name, config, scope: "default" as const }] : [])),
	);

/**
 * The host's research server as its default entry declares it. Tests take the server name, prefix, reader and search
 * tools from here, so none of them lists the tools a server release ships.
 */
export const RESEARCH = (() => {
	const research = builtinRoles().research;
	if (!research) throw new Error("the default servers declare no research server");
	return research;
})();
