/**
 * Where the host teaches the redactors which credentials this process holds. Pattern-based `redactSecrets` misses a key
 * with no known prefix; the registry in `common` removes exact values, and `packages/ai` (which may not import `common`)
 * reaches it through the hook installed here. Credential resolution calls the `register*` functions with what it resolved.
 */
import type { Credential, ModelAuth, ProviderEnv } from "@octocodeai/octocode-ai";
import { setProviderTextRedactor } from "@octocodeai/octocode-ai/utils/error-body";
import { redactSecrets, registerSecretValue } from "../../../common/src/sanitize.ts";

/** Header and environment names that carry a credential; other values (content types, account ids) stay readable in errors. */
const SECRET_NAME = /auth|key|token|secret|password|passwd|cookie|credential|session/iu;

/**
 * Makes provider error text (session history, `output.errorMessage`, OAuth and image errors) pass through `redactSecrets`.
 * Called where every `ModelRuntime` loads, so interactive, print, RPC, SDK and subagent-child sessions all share it.
 */
export function installSecretRedaction(): void {
	setProviderTextRedactor(redactSecrets);
}

/** Registers one resolved secret; a `Bearer abc…` or `Basic abc…` header value registers its token, which an error would quote alone. */
export function registerResolvedSecret(value: string | undefined): void {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("!")) return;
	registerSecretValue(trimmed);
	const token = /\s/u.test(trimmed) ? trimmed.split(/\s+/u).at(-1) : undefined;
	if (token) registerSecretValue(token);
}

/** Registers the entries of `values` whose name says they hold a credential. */
export function registerNamedSecrets(values: Readonly<Record<string, unknown>> | undefined): void {
	for (const [name, value] of Object.entries(values ?? {})) {
		if (typeof value === "string" && SECRET_NAME.test(name)) registerResolvedSecret(value);
	}
}

/** Registers an API key, or an OAuth credential's access and refresh tokens. */
export function registerCredentialSecrets(credential: Credential | undefined): void {
	if (!credential) return;
	if (credential.type === "api_key") {
		registerResolvedSecret(credential.key);
		registerNamedSecrets(credential.env);
	} else {
		registerResolvedSecret(credential.access);
		registerResolvedSecret(credential.refresh);
	}
}

/** Registers what a provider resolved for a request: the key, credential-bearing headers, credential-bearing environment values. */
export function registerAuthSecrets(auth: ModelAuth | undefined, env?: ProviderEnv): void {
	if (!auth) return;
	registerResolvedSecret(auth.apiKey);
	registerNamedSecrets(auth.headers);
	registerNamedSecrets(env);
}
