import { join } from "node:path";
import { APP_NAME, getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

/** Where the message is read: inside a session (slash commands work) or on the command line (they do not). */
export type AuthGuidanceSurface = "session" | "cli";

/** Nothing can run until the user gives this model credentials. Protocols mark it so a client can route to sign-in. */
export class AuthRequiredError extends Error {}

function getProviderLoginHelp(surface: AuthGuidanceSurface = "session"): string {
	const action =
		surface === "cli"
			? `Run \`${APP_NAME}\` and use /login to connect an AI provider with an account or API key, or set the provider's API key environment variable (for example OPENAI_API_KEY). See:`
			: "Use /login to connect an AI provider with an account or API key. See:";
	return [action, `  ${join(getDocsPath(), "providers.md")}`, `  ${join(getDocsPath(), "models.md")}`].join("\n");
}

export function formatNoModelsAvailableMessage(surface: AuthGuidanceSurface = "session"): string {
	return `No models available. ${getProviderLoginHelp(surface)}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
