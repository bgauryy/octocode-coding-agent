import type { Credential } from "@octocodeai/octocode-ai";
import type { AuthStatus } from "./types.ts";

/** What a provider's credential is doing now, in the words a provider row and page use. */
export type CredentialState = "connected" | "expired" | "signed out" | "not set";

/**
 * The state of a provider's credential. `credential` is what is saved for it (undefined when nothing is). An OAuth
 * sign-in is expired when its access token is past `expires` and no refresh token can renew it (none saved, or the
 * provider refused it for good); signed out when it was signed out and only its registration remains. Anything else
 * that configures the provider is connected; no usable credential at all is not set.
 */
export function credentialState(
	status: Pick<AuthStatus, "configured" | "source">,
	credential: Credential | undefined,
	now = Date.now(),
): CredentialState {
	if (status.source === "runtime") return "connected";
	if (credential?.type === "oauth") {
		if (credential.signedOut) return "signed out";
		if (credential.expires <= now && (!credential.refresh || credential.refreshRejected)) return "expired";
	}
	return status.configured ? "connected" : "not set";
}
