export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.OCTOCODE_EXPERIMENTAL === "1";
}
