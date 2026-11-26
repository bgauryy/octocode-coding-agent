import {
	type AuthCheck,
	type Credential,
	type CredentialStore,
	InMemoryModelsStore,
	isUnreadableKeychainStub,
	KEYCHAIN_UNREADABLE_MESSAGE,
} from "@octocodeai/octocode-ai";
import { findEnvKeys, providersSharingApiKeyEnvVar } from "@octocodeai/octocode-ai/compat";
import { credentialErrorCause } from "../core/credential-cause.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelsProject } from "../core/model-config/project.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

type AuthCheckStatus = "ready" | "not_ready" | "invalid";
type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_not_available"
	| "keychain_unreadable"
	| "invalid_state";

export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	reason?: AuthCheckReason;
	authType?: "api_key" | "oauth";
	/** Where the credential comes from: the stored credential, an environment variable name, or an ambient source. */
	source?: string;
	/** Why the check failed, for the provider alone: a command's exit status, a missing variable, an unreadable file. Never a secret. */
	detail?: string;
	/** True only when the provider accepted the credential. `auth check` makes no provider request, so it is false. */
	verified: boolean;
	/** The other providers that read the environment variable named by `source`, so they look ready too. */
	sharedWith?: string[];
	/** Things worth knowing that do not change the status, such as a stored credential hiding an environment variable. */
	warnings?: string[];
}

const REASON_TEXT: Record<AuthCheckReason, string> = {
	provider_not_found: "no provider with this id",
	credentials_not_configured: "no credential is configured",
	credential_not_available: "the credential could not be resolved",
	keychain_unreadable: KEYCHAIN_UNREADABLE_MESSAGE,
	invalid_state: "credential state could not be read",
};

/** The `auth check` text: the status on the first line, then what it rests on, one `name: value` line each. */
export function formatAuthCheck(result: AuthCheckResult): string {
	const lines: string[] = [result.status];
	if (result.reason) lines.push(`reason: ${REASON_TEXT[result.reason]}`);
	if (result.detail) lines.push(`detail: ${result.detail}`);
	if (result.source) {
		const shared = result.sharedWith?.length ? ` (also read by ${result.sharedWith.join(", ")})` : "";
		lines.push(`source: ${result.source}${shared}`);
	}
	lines.push(`verified: ${result.verified}`);
	for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
	return lines.join("\n");
}

/** What the resolved source of a ready check implies: variables it hides, and providers that share its variable. */
function describeSource(
	provider: string,
	auth: AuthCheck,
	stored: Credential | undefined,
): Pick<AuthCheckResult, "sharedWith" | "warnings"> {
	const envNames = findEnvKeys(provider) ?? [];
	if (auth.source && envNames.includes(auth.source)) {
		const sharedWith = providersSharingApiKeyEnvVar(auth.source, provider);
		return sharedWith.length > 0 ? { sharedWith } : {};
	}
	if (!stored || envNames.length === 0) return {};
	return {
		warnings: [
			`The stored credential is used; ${envNames.join(", ")} ${envNames.length > 1 ? "are" : "is"} also set and ignored. Remove the stored credential to use the environment variable.`,
		],
	};
}

export async function checkProviderAuth(
	args: Args,
	modelRuntime: ModelRuntime,
	options: { refresh: boolean; signal?: AbortSignal } = { refresh: false },
): Promise<AuthCheckResult> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "check");
	let provider = cliProvider;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		provider = resolved.model.provider;
	}
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	// A models.json problem belongs to the providers it defines: another provider is checked on its own.
	if (!modelRuntime.getProvider(provider)) {
		// A provider that only an untrusted workspace file defines is missing for lack of trust; a broken file may hide it too.
		const detail = modelRuntime.getModelsDiagnostics().untrustedHint(provider) ?? firstLine(modelRuntime.getError());
		return {
			status: "not_ready",
			provider,
			reason: "provider_not_found",
			...(detail ? { detail } : {}),
			verified: false,
		};
	}
	try {
		const stored = await modelRuntime.readCredential(provider, { signal: options.signal });
		// A reference to an unreadable keychain record is no credential: say why, and never fall back to ambient ones.
		if (isUnreadableKeychainStub(stored)) {
			return { status: "not_ready", provider, reason: "keychain_unreadable", verified: false };
		}
		const auth = await modelRuntime.checkAuth(provider, { signal: options.signal });
		if (!auth) return notConfigured(modelRuntime, provider);
		if (options.refresh && !(await modelRuntime.getAuth(provider, { signal: options.signal }))) {
			return notConfigured(modelRuntime, provider);
		}
		return {
			status: "ready",
			provider,
			authType: auth.type,
			...(auth.source ? { source: auth.source } : {}),
			verified: false,
			...describeSource(provider, auth, stored),
		};
	} catch (error) {
		return {
			status: "invalid",
			provider,
			reason: "invalid_state",
			detail: credentialErrorCause(error),
			verified: false,
		};
	}
}

/** No credential: names the variable a `$NAME` key waits for, when that is why. */
function notConfigured(modelRuntime: ModelRuntime, provider: string): AuthCheckResult {
	const status = modelRuntime.getProviderAuthStatus(provider);
	const detail =
		!status.configured && status.source === "environment" && status.label
			? `environment variable ${status.label} is not set`
			: undefined;
	return {
		status: "not_ready",
		provider,
		reason: "credentials_not_configured",
		...(detail ? { detail } : {}),
		verified: false,
	};
}

const firstLine = (text: string | undefined): string | undefined => text?.split("\n")[0] || undefined;

export async function getProviderCredential(
	providerId: string,
	modelRuntime: ModelRuntime,
	credentials: CredentialStore,
	options: { refresh: boolean; signal?: AbortSignal },
): Promise<string | undefined> {
	const credential = await credentials.read(providerId, { signal: options.signal });
	if (!options.refresh && credential?.type === "oauth") return credential.access;
	return getAuthCredential(await modelRuntime.getAuth(providerId, { signal: options.signal }));
}

export async function createAuthCheckModelRuntime(
	credentials: CredentialStore,
	signal?: AbortSignal,
	project?: ModelsProject,
): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		...(project ? { project } : {}),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
		signal,
	});
}
