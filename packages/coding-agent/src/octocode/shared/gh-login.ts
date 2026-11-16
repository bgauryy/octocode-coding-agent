import fs from "node:fs";
import path from "node:path";

/** A token in the environment, or a host with a user in gh's `hosts.yml`; read locally, never validated over the network. */
export function ghLoggedIn(env: NodeJS.ProcessEnv, windows: boolean, home: string): boolean {
	if (env.GH_TOKEN || env.GITHUB_TOKEN) return true;
	const appData = env.AppData ?? env.APPDATA ?? path.join(home, "AppData", "Roaming");
	const configDir =
		env.GH_CONFIG_DIR ??
		(windows ? path.join(appData, "GitHub CLI") : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "gh"));
	let hosts: string;
	try {
		hosts = fs.readFileSync(path.join(configDir, "hosts.yml"), "utf8");
	} catch {
		// No hosts file: gh has never logged in on this machine.
		return false;
	}
	return /^\s+(?:user|oauth_token):\s*\S/m.test(hosts);
}
