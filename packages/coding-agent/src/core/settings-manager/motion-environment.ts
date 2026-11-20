/** Environment variables that ask for reduced motion when set to `1` or `true`. */
const REDUCE_MOTION_VARIABLES = ["OCTOCODE_REDUCE_MOTION", "REDUCE_MOTION", "NO_MOTION"] as const;

const isOn = (value: string | undefined): boolean => {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

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
