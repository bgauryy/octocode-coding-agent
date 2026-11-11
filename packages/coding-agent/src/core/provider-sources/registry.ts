import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { COPILOT_ENV_VAR } from "./copilot-env.ts";
import { displayPath, nodeProviderSourceFs } from "./detect.ts";
import { isSourceEnabled, normalizeProviderSources, SOURCE_DEFAULTS } from "./gate.ts";
import type { ProviderSource, ProviderSourceEnvironment, ProviderSourceOverrides } from "./types.ts";

/**
 * The provider sources with their current state, for `/providers`. `overrides` is the `providerSources` setting.
 * `present` only says a file exists or the variable is set; no value is read into the result.
 */
export function describeProviderSources(overrides: unknown, options: ProviderSourceEnvironment = {}): ProviderSource[] {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const fs = options.fs ?? nodeProviderSourceFs;
	const agentDir = options.agentDir ?? getAgentDir();
	const chosen: ProviderSourceOverrides = normalizeProviderSources(overrides);
	// The `pi` switch governs every read-only fallback folder: the Octocode Pi extension's, then Pi's.
	const piDirs = [
		join(home, CONFIG_DIR_NAME, "agent"),
		join(home, CONFIG_DIR_NAME),
		join(home, ".pi", "agent"),
		join(home, ".pi"),
	];
	const piPaths = piDirs.flatMap((dir) => [join(dir, "auth.json"), join(dir, "models.json")]);
	const ownPaths = [join(agentDir, "auth.json"), join(agentDir, "models.json")];
	const state = (id: ProviderSource["id"], present: boolean) => ({
		enabled: isSourceEnabled(id, chosen),
		overridden: id !== "octocode" && chosen[id] !== undefined,
		present,
	});
	return [
		{
			id: "octocode",
			label: "Octocode",
			provides: ["credentials", "models"],
			paths: [...ownPaths.map((path) => displayPath(path, home)), "keychain"],
			defaultEnabled: true,
			toggleable: false,
			state: state(
				"octocode",
				ownPaths.some((path) => fs.exists(path)),
			),
		},
		{
			id: "pi",
			label: "Pi",
			provides: ["credentials", "models"],
			paths: piPaths.map((path) => displayPath(path, home)),
			defaultEnabled: SOURCE_DEFAULTS.pi,
			toggleable: true,
			state: state(
				"pi",
				piPaths.some((path) => fs.exists(path)),
			),
		},
		{
			id: "copilot-env",
			label: COPILOT_ENV_VAR,
			provides: ["credentials"],
			paths: [`$${COPILOT_ENV_VAR}`],
			defaultEnabled: SOURCE_DEFAULTS["copilot-env"],
			toggleable: true,
			state: state("copilot-env", Boolean(env[COPILOT_ENV_VAR]?.trim())),
		},
	];
}
