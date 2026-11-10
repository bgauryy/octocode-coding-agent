import { findEnvKeys } from "@octocodeai/octocode-ai/compat";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { getOctocodeHome } from "../../config.ts";

/** What a detached, long-lived process needs from the launching session's environment, and nothing else. */
const KEPT =
	/^(HOME|USERPROFILE|PATH|SHELL|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|TERM|NODE_OPTIONS|SystemRoot|SYSTEMROOT|windir|ComSpec|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+)$/;
/** An Octocode setting is kept unless its name says it holds a credential. */
const CREDENTIAL_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * The environment and working directory for the daemon process. The daemon outlives its session and holds a token for
 * every session, so it does not inherit provider keys, proxies or other tokens: it keeps `OCTOCODE_*` settings (home,
 * agent directories, the idle timeout), locale, `PATH` and `HOME`. For each provider whose API-key variable is set in
 * the launching environment it gets that variable with a placeholder value, so the Settings page can say the key is
 * set without the daemon ever holding it. Its working directory is the Octocode home, not the session's folder.
 */
export function daemonSpawnOptions(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cwd: string } {
	const kept: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (KEPT.test(name) || (name.startsWith("OCTOCODE_") && !CREDENTIAL_NAME.test(name))) kept[name] = value;
	}
	for (const provider of builtinProviders())
		for (const name of findEnvKeys(provider.id, env as Record<string, string>) ?? []) kept[name] = "set";
	return { env: kept, cwd: getOctocodeHome(env) };
}
