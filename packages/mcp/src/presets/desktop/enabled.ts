import { DESKTOP_SERVER } from "@octocodeai/octocode-common/mcp-names";
import { loadMcpConfig } from "../../config.ts";
import { presetEntries } from "../../preset.ts";
import { desktopAvailable, desktopPreset } from "./index.ts";

/**
 * Whether the `desktop` server will run in a session started in `cwd`: Cua Driver is found (`desktopAvailable`) and the
 * user's own configuration (`mcp.json`, a switch from `/configuration disable mcp:desktop`) has not switched it off. The
 * `desktop` specialist and the coordinator's desktop guidance exist only then, so a server the user turned off leaves no
 * profile that would try to start it.
 */
export function desktopEnabled(
	input: { agentDir: string; cwd: string; projectTrusted: boolean },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!desktopAvailable(env)) return false;
	const loaded = loadMcpConfig({ ...input, defaults: presetEntries([desktopPreset(env)]) });
	return loaded.servers.find((server) => server.name === DESKTOP_SERVER)?.config.enabled !== false;
}
