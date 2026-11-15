/**
 * Recommended servers: configuration data only (`<name>.json`, one server entry plus `name`, an optional `enabledEnv`,
 * the environment flag that turns it off or on, and an optional `enabledWhenOnPath`, a command that must be on PATH for
 * the server to be on by default). A server gated on a command is also off by default in offline mode, since its first
 * launch installs its package from npm. They register as `scope: "default"` entries, which a user or project entry of
 * the same name replaces; a saved switch (`/harness`, `/configuration`) is a control-only override and wins over both.
 * Nothing server-specific lives in TypeScript.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag, OFFLINE_ENV } from "../../../common/src/env.ts";
import { findOnPath } from "../../../common/src/find-on-path.ts";
import type { McpServerPreset } from "../preset.ts";
import { validateMcpServerConfig } from "../servers.ts";
import freellama from "./freellama.json" with { type: "json" };
import octocode from "./octocode.json" with { type: "json" };

// The first entry is the research server (tests and role resolution rely on the order).
const DATA: readonly unknown[] = [octocode, freellama];

/**
 * One recommended entry as a preset: its name and configuration, with `enabled` from its environment flag, else from
 * whether its `enabledWhenOnPath` command is on `env.PATH` outside offline mode.
 */
export function recommendedPreset(data: unknown, env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	if (!isRecord(data) || typeof data.name !== "string") throw new Error("recommended server data needs a name");
	const { name, enabledEnv, enabledWhenOnPath, ...rest } = data;
	if (enabledEnv !== undefined && typeof enabledEnv !== "string") {
		throw new Error(`recommended server "${name}": enabledEnv must be a string`);
	}
	if (enabledWhenOnPath !== undefined && typeof enabledWhenOnPath !== "string") {
		throw new Error(`recommended server "${name}": enabledWhenOnPath must be a string`);
	}
	const byDefault =
		enabledWhenOnPath === undefined || (!envFlag(env, OFFLINE_ENV) && findOnPath(enabledWhenOnPath, env) !== undefined);
	const gated = enabledEnv !== undefined || enabledWhenOnPath !== undefined;
	const config = validateMcpServerConfig(name, {
		...rest,
		...(gated ? { enabled: enabledEnv ? envFlag(env, enabledEnv, byDefault) : byDefault } : {}),
	});
	if (typeof config === "string") throw new Error(`recommended server data: ${config}`);
	return { name, config };
}

/** Every recommended server, in a fixed order. */
export function recommendedPresets(env: NodeJS.ProcessEnv = process.env): McpServerPreset[] {
	return DATA.map((data) => recommendedPreset(data, env));
}
