import { getConfigValueEnvVarNames, isCommandConfigValue } from "../config-value.ts";
import type { ProviderLayers } from "./provider-layers.ts";

/** Why a models.json provider that adds models has no credential, and what to do about it. */
export function missingCredentialWarning(layers: ProviderLayers, providerId: string): string {
	const subject = `models.json provider "${providerId}"`;
	const apiKey = layers.config.getProvider(providerId)?.apiKey;
	if (apiKey !== undefined && isCommandConfigValue(apiKey)) {
		return `${subject} has no credential: its apiKey comes from a command, which could not be used, so its models cannot run.`;
	}
	const unset = apiKey === undefined ? [] : getConfigValueEnvVarNames(apiKey).filter((name) => !process.env[name]);
	if (unset.length > 0) {
		const names = unset.map((name) => `$${name}`).join(", ");
		return `${subject} has no credential: its apiKey uses ${names}, which ${unset.length > 1 ? "are" : "is"} not set, so its models cannot run. Set it, or save a key or sign in with /providers.`;
	}
	return (
		`${subject} has no credential, so its models cannot run. Add "apiKey" to it ` +
		`(a key, "$ENV_NAME" or "!command"), or save a key or sign in with /providers.`
	);
}
