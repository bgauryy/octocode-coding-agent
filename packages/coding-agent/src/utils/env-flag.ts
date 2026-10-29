/** True for the values `1`, `true` and `yes` (case-insensitive); unset or empty is false. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isOfflineModeEnabled(): boolean {
	return isTruthyEnvFlag(process.env.OCTOCODE_OFFLINE);
}
