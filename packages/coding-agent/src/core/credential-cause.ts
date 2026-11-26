import { redactSecrets } from "@octocodeai/octocode-common/sanitize";

/**
 * Why a credential could not be resolved, from the deepest error of the `cause` chain (the provider wrappers only say
 * which provider failed). Quotes the exit status, variable name or file the failing step named, never a secret: the
 * resolvers leave command text and output out, and the text also passes through the secret redactor.
 */
export function credentialErrorCause(error: unknown): string {
	let deepest: unknown = error;
	const seen = new Set<unknown>();
	while (deepest instanceof Error && deepest.cause !== undefined && !seen.has(deepest)) {
		seen.add(deepest);
		deepest = deepest.cause;
	}
	const message = deepest instanceof Error ? deepest.message : String(deepest);
	return redactSecrets(message.trim().split("\n")[0] ?? "");
}
