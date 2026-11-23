import { APP_NAME, getDocsPath } from "../config.ts";

/** Where the message is read: inside a session (slash commands work) or on the command line (they do not). */
export type AuthGuidanceSurface = "session" | "cli";

/**
 * The surface of this process's messages. A headless run (print, JSON, RPC outside a subagent) sets `cli` once at start:
 * its errors reach a shell or a client program, where `/providers` cannot be typed.
 */
let processSurface: AuthGuidanceSurface = "session";

export function setAuthGuidanceSurface(surface: AuthGuidanceSurface): void {
	processSurface = surface;
}

export function authGuidanceSurface(): AuthGuidanceSurface {
	return processSurface;
}

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

/** How to sign in to one provider again, where the reader is. */
function getSignInAgainAction(provider: string, surface: AuthGuidanceSurface): string {
	return surface === "cli"
		? `Run \`${APP_NAME}\` and type /providers ${provider} to sign in again.`
		: `Type /providers ${provider} to sign in again.`;
}

export function formatNoModelsAvailableMessage(surface: AuthGuidanceSurface = processSurface): string {
	return `No AI provider connected yet. ${getProviderLoginAction(surface)}\n${getDocsLine()}`;
}

export function formatNoModelSelectedMessage(surface: AuthGuidanceSurface = processSurface): string {
	const pick = surface === "cli" ? "Then pick a model with --model <provider>/<id>." : "Then /model to pick a model.";
	return `No model selected. ${getProviderLoginAction(surface)} ${pick}\n${getDocsLine()}`;
}

export function formatNoApiKeyFoundMessage(provider: string, surface: AuthGuidanceSurface = processSurface): string {
	const action =
		surface === "cli"
			? `Set its API key environment variable, or run \`${APP_NAME}\` and type /providers to sign in; \`${APP_NAME} auth check --provider ${provider}\` shows what is found.`
			: "Type /providers to sign in or configure credentials, then /model to pick a model.";
	return `No usable credentials for ${provider}. ${action}\n${getDocsLine()}`;
}

/** The stored OAuth sign-in could not be renewed; `reason` is the provider's failure, kept for diagnosis. */
export function formatAuthRefreshFailedMessage(
	provider: string,
	reason: string,
	surface: AuthGuidanceSurface = processSurface,
): string {
	return `Sign-in for ${provider} could not be renewed. ${getSignInAgainAction(provider, surface)} (${reason})`;
}

/** The provider uses OAuth and its sign-in no longer works: expired credentials, or the network is down. */
export function formatAuthExpiredMessage(provider: string, surface: AuthGuidanceSurface = processSurface): string {
	return `Sign-in for ${provider} failed: the credentials may have expired, or the network is down. ${getSignInAgainAction(provider, surface)}`;
}
