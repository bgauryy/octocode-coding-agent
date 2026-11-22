/**
 * Recommended servers: configuration data only (`<name>.json`, one server entry plus `name`, an optional `enabledEnv`,
 * the environment flag that turns it off or on, an optional `enabledByDefault`, false for a server the user turns on
 * with that flag or a configuration entry, optional `envDefaults`, launch env values added only when the user's own
 * environment leaves that variable unset, and an optional `instructionsOnDemand`, `McpServerPreset.instructionsOnDemand`).
 * They register as `scope: "default"` entries, which a user or project entry of the same name replaces; a saved switch
 * (`/harness`, `/settings`) is a control-only override and wins over both.
 * Nothing server-specific lives in TypeScript.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag } from "@octocodeai/octocode-common/env";
import type { McpServerPreset } from "../preset.ts";
import { validateMcpServerConfig } from "../servers.ts";
import freellama from "./freellama.json" with { type: "json" };
import octocode from "./octocode.json" with { type: "json" };

// The first entry is the research server (tests and role resolution rely on the order).
const DATA: readonly unknown[] = [octocode, freellama];

/**
 * One recommended entry as a preset: its name and configuration, with `enabled` from its environment flag, else from
 * its `enabledByDefault` (on when unset).
 */
export function recommendedPreset(data: unknown, env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	if (!isRecord(data) || typeof data.name !== "string") throw new Error("recommended server data needs a name");
	const { name, enabledEnv, enabledByDefault, envDefaults, instructionsOnDemand, ...rest } = data;
	if (enabledEnv !== undefined && typeof enabledEnv !== "string") {
		throw new Error(`recommended server "${name}": enabledEnv must be a string`);
	}
	if (enabledByDefault !== undefined && typeof enabledByDefault !== "boolean") {
		throw new Error(`recommended server "${name}": enabledByDefault must be true or false`);
	}
	if (envDefaults !== undefined && !isStringRecord(envDefaults)) {
		throw new Error(`recommended server "${name}": envDefaults must map names to strings`);
	}
	if (instructionsOnDemand !== undefined && typeof instructionsOnDemand !== "boolean") {
		throw new Error(`recommended server "${name}": instructionsOnDemand must be a boolean`);
	}
	const launchEnv = { ...unsetIn(env, envDefaults), ...(isRecord(rest.env) ? rest.env : {}) };
	const byDefault = enabledByDefault !== false;
	const gated = enabledEnv !== undefined || enabledByDefault !== undefined;
	const config = validateMcpServerConfig(name, {
		...rest,
		...(Object.keys(launchEnv).length > 0 ? { env: launchEnv } : {}),
		...(gated ? { enabled: enabledEnv ? envFlag(env, enabledEnv, byDefault) : byDefault } : {}),
	});
	if (typeof config === "string") throw new Error(`recommended server data: ${config}`);
	return { name, config, ...(instructionsOnDemand ? { instructionsOnDemand } : {}) };
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** The defaults whose variable `env` leaves unset: a value the user set reaches the server unchanged. */
function unsetIn(env: NodeJS.ProcessEnv, defaults: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(defaults ?? {}).filter(([key]) => env[key] === undefined));
}

/** Every recommended server, in a fixed order. */
export function recommendedPresets(env: NodeJS.ProcessEnv = process.env): McpServerPreset[] {
	return DATA.map((data) => recommendedPreset(data, env));
}
