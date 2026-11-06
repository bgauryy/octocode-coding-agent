import { hostIdentity, hostPaths } from "../../../mcp/src/host.ts";
import { hostDependencyBin } from "../../../mcp/src/host-dependency.ts";
import { recommendedPresets } from "../../../mcp/src/recommended/index.ts";

/**
 * How a test starts the host's own research server (the host dependency the default entry installs from): node running
 * its built bin, with the roots the default entry's `${researchRoots}` template gives a session.
 */
export function researchServerLaunch(
	cwd: string,
	skillDirectories: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: Record<string, string> } {
	const config = recommendedPresets(env)[0]?.config;
	const install = config && !("url" in config) ? config.install : undefined;
	if (!install) throw new Error("the default server declares no install");
	const found = hostDependencyBin(install, hostIdentity().packageDir());
	if (!found || !("bin" in found)) throw new Error("the host's research server is not built");
	const roots = [cwd, ...hostPaths().sessionRoots(cwd, env), ...skillDirectories];
	return {
		command: process.execPath,
		args: [found.bin],
		env: { WORKSPACE_ROOT: cwd, ALLOWED_PATHS: [...new Set(roots)].join(",") },
	};
}
