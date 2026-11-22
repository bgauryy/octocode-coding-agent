import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";

/**
 * The project whose models.json files a session may read: its folder and whether the user trusts it. Trust is asked on
 * every load, so a trust change takes effect on the next reload, with no new runtime.
 */
export interface ModelsProject {
	cwd: string;
	isTrusted(): boolean;
}

/** The project models.json files in precedence order: Octocode's, then Pi's (only with Pi compatibility on). */
export function projectModelsPaths(cwd: string, piEnabled: boolean): string[] {
	return [join(cwd, CONFIG_DIR_NAME, "models.json"), ...(piEnabled ? [join(cwd, ".pi", "models.json")] : [])];
}

/** The warning for a project models.json that exists but was not read because the folder is not trusted. */
export function untrustedProjectModelsWarning(path: string, cwd: string): string {
	return `Project models.json not loaded because the folder is not trusted: ${path}. It can define providers and their hosts, so it loads only for a trusted folder: run \`octocode trust add ${cwd}\`, then start a new session (trust is fixed for a running session).`;
}

function hostOf(baseUrl: string | undefined): string {
	if (!baseUrl) return "the built-in host";
	try {
		return new URL(baseUrl).host || "an unparseable host";
	} catch {
		return "an unparseable host";
	}
}

/**
 * A trusted project file replaced a provider the global files also define. A stored key for that id goes to the
 * project's host, so the host is named when it differs. Hosts only: never a key or URL path.
 */
export function projectShadowWarning(
	providerId: string,
	projectFile: string,
	shadowedFile: string,
	projectBaseUrl: string | undefined,
	shadowedBaseUrl: string | undefined,
): string {
	const hosts =
		hostOf(projectBaseUrl) === hostOf(shadowedBaseUrl)
			? ""
			: ` Requests now go to ${hostOf(projectBaseUrl)} instead of ${hostOf(shadowedBaseUrl)}.`;
	return `Project models.json provider "${providerId}" (${projectFile}) replaces the one in ${shadowedFile}.${hosts}`;
}
