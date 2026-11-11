import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AcpClientHost } from "../host.ts";
import { authRequiredIn } from "./auth.ts";
import { AcpBackend, type AcpConnectInput } from "./client.ts";

/**
 * Whether an ACP agent can open a session without a person: signed in, signed out (with the sign-in methods it offers,
 * names only), or unknown with the reason the check could not tell.
 */
export type AcpSignIn = { signedIn: true } | { signedIn: false; methods: string[] } | { error: string };

/**
 * The sign-in check of last resort, for an agent whose CLI has no status command: `initialize` and `session/new` in
 * `input.cwd` (a folder of its own, so no project is touched), then the connection closes. It never authenticates and
 * never prompts: an `auth_required` answer means signed out. Permission requests cannot arrive without a prompt.
 */
export async function probeAcpSignIn(
	host: AcpClientHost,
	input: Omit<AcpConnectInput, "authenticate" | "sessionId" | "model">,
	signal?: AbortSignal,
): Promise<AcpSignIn> {
	try {
		const backend = await AcpBackend.connect(
			host,
			{ ...input, authenticate: false },
			async () => ({ outcome: { outcome: "cancelled" } }),
			signal,
		);
		await backend.close();
		return { signedIn: true };
	} catch (error) {
		const required = authRequiredIn(error);
		return required ? { signedIn: false, methods: required.methods } : { error: errorMessage(error) };
	}
}
