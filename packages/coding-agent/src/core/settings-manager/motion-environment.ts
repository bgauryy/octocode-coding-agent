/** Environment variables that ask for reduced motion when set to `1` or `true`. */
const REDUCE_MOTION_VARIABLES = ["OCTOCODE_REDUCE_MOTION", "REDUCE_MOTION", "NO_MOTION"] as const;

const isOn = (value: string | undefined): boolean => {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

/** `OCTOCODE_LATENCY_FENCE`: `0`/`false` is off, `1`/`true` on; anything else (or unset) leaves the setting in charge. */
export function environmentLatencyFence(env: Readonly<Record<string, string | undefined>>): boolean | undefined {
	const value = env.OCTOCODE_LATENCY_FENCE?.trim().toLowerCase();
	if (value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	return undefined;
}

/** Whether `OCTOCODE_SCREEN_READER` is `1` or `true`. */
export function environmentWantsScreenReader(env: Readonly<Record<string, string | undefined>>): boolean {
	return isOn(env.OCTOCODE_SCREEN_READER);
}

/**
 * Whether the environment alone asks for still decoration: a reduced-motion variable (`OCTOCODE_REDUCE_MOTION`,
 * `REDUCE_MOTION`, `NO_MOTION`), output that is not a terminal (a pipe or file would collect every frame), or a CI run.
 */
export function environmentWantsStillMotion(
	env: Readonly<Record<string, string | undefined>>,
	stdoutIsTty: boolean | undefined,
): boolean {
	if (REDUCE_MOTION_VARIABLES.some((name) => isOn(env[name]))) return true;
	if (!stdoutIsTty) return true;
	const ci = env.CI?.trim().toLowerCase();
	return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}
