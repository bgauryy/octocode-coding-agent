import { envFlag } from "../../../common/src/env.ts";

/** Disables startup network operations; `--offline` sets it for the process and its children. */
export const OFFLINE_ENV = "OCTOCODE_OFFLINE";

/** True for `1`, `true`, `on` and `yes` (any case, surrounding space ignored); unset, empty or anything else is false. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	return envFlag({ value }, "value");
}

/**
 * Whether offline mode is on. Every offline decision (startup refreshes, model discovery, version checks, telemetry,
 * bug upload, package and tool downloads) goes through this, so `OCTOCODE_OFFLINE=0` or `false` means online everywhere.
 */
export function isOfflineModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlag(env, OFFLINE_ENV);
}
