import { APP_NAME, getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

/** Where the message is read: inside a session (slash commands work) or on the command line (they do not). */
export type AuthGuidanceSurface = "session" | "cli";

/** Nothing can run until the user gives this model credentials. Protocols mark it so a client can route to sign-in. */
export class AuthRequiredError extends Error {}

function getDocsLine(): string {
	return `Docs: providers.md · models.md in ${getDocsPath()}`;
}

function getProviderLoginAction(surface: AuthGuidanceSurface): string {
	return surface === "cli"
		? `Run \`${APP_NAME}\` and type /providers to connect one with an account or API key, or set the provider's API key environment variable (for example OPENAI_API_KEY).`
		: "Type /providers to connect one with an account or API key.";
}

export function formatNoModelsAvailableMessage(surface: AuthGuidanceSurface = "session"): string {
	return `No AI provider connected yet. ${getProviderLoginAction(surface)}\n${getDocsLine()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected. ${getProviderLoginAction("session")} Then /model to pick a model.\n${getDocsLine()}`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No usable credentials for ${providerDisplay}. Type /providers to sign in or configure credentials, then /model to pick a model.\n${getDocsLine()}`;
}

/** The stored OAuth sign-in could not be renewed; `reason` is the provider's failure, kept for diagnosis. */
export function formatAuthRefreshFailedMessage(provider: string, reason: string): string {
	return `Sign-in for ${provider} could not be renewed. Type /providers ${provider} to sign in again. (${reason})`;
}

/** The provider uses OAuth and its sign-in no longer works: expired credentials, or the network is down. */
export function formatAuthExpiredMessage(provider: string): string {
	return `Sign-in for ${provider} failed: the credentials may have expired, or the network is down. Type /providers ${provider} to sign in again.`;
}
