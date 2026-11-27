import { urlCredentialProblem } from "@octocodeai/octocode-common/url-credentials";
import { isCommandConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { usesCredentialProgram } from "./credentials.ts";

/** The parts of a models.json provider these checks read. */
interface CheckedProvider {
	apiKey?: string;
	auth?: unknown;
	baseUrl?: string;
	headers?: Record<string, string>;
	models?: readonly { id: string; baseUrl?: string; headers?: Record<string, string> }[];
	modelOverrides?: Record<string, { headers?: Record<string, string> }>;
}

export function usesSecretCommand(provider: CheckedProvider): boolean {
	const commandHeader = (headers?: Record<string, string>) => Object.values(headers ?? {}).some(isCommandConfigValue);
	return (
		(!!provider.apiKey && isCommandConfigValue(provider.apiKey)) ||
		usesCredentialProgram(provider) ||
		commandHeader(provider.headers) ||
		(provider.models ?? []).some((model) => commandHeader(model.headers)) ||
		Object.values(provider.modelOverrides ?? {}).some((model) => commandHeader(model.headers))
	);
}

/** Every baseUrl that carries a credential, as `providers.<id>.baseUrl` paths and what is wrong; never the URL itself. */
export function baseUrlCredentialErrors(providers: Record<string, CheckedProvider>): string[] {
	const errors: string[] = [];
	for (const [providerId, provider] of Object.entries(providers)) {
		const fields: [string, string | undefined][] = [
			[`providers.${providerId}.baseUrl`, provider.baseUrl],
			...(provider.models ?? []).map((model): [string, string | undefined] => [
				`providers.${providerId}.models[${model.id}].baseUrl`,
				model.baseUrl,
			]),
		];
		for (const [field, value] of fields) {
			const problem = value === undefined ? undefined : urlCredentialProblem(value);
			if (problem) {
				errors.push(`  - ${field}: ${problem}; put the key in apiKey or headers instead`);
			}
		}
	}
	return errors;
}

export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
