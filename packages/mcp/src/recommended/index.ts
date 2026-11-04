/**
 * Recommended servers: configuration data only (`<name>.json`, one server entry plus `name` and an optional
 * `enabledEnv`, the environment flag that turns it off). They register as `scope: "default"` entries, which a user or
 * project entry of the same name replaces. Nothing server-specific lives in TypeScript.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag } from "../../../common/src/env.ts";
import type { McpServerPreset } from "../preset.ts";
import { validateMcpServerConfig } from "../servers.ts";
import octocode from "./octocode.json" with { type: "json" };

const DATA: readonly unknown[] = [octocode];

/** One recommended entry as a preset: its name and configuration, with `enabled` from its environment flag. */
export function recommendedPreset(data: unknown, env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	if (!isRecord(data) || typeof data.name !== "string") throw new Error("recommended server data needs a name");
	const { name, enabledEnv, ...rest } = data;
	if (enabledEnv !== undefined && typeof enabledEnv !== "string") {
		throw new Error(`recommended server "${name}": enabledEnv must be a string`);
	}
	const config = validateMcpServerConfig(name, {
		...rest,
		...(enabledEnv ? { enabled: envFlag(env, enabledEnv, true) } : {}),
	});
	if (typeof config === "string") throw new Error(`recommended server data: ${config}`);
	return { name, config };
}

/** Every recommended server, in a fixed order. */
export function recommendedPresets(env: NodeJS.ProcessEnv = process.env): McpServerPreset[] {
	return DATA.map((data) => recommendedPreset(data, env));
}
