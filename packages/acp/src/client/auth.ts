import { type AuthMethod, type ClientConnection, methods, RequestError } from "@agentclientprotocol/sdk";
import { untilAborted } from "@octocodeai/octocode-common/abort";

/** ACP's `auth_required` code: the agent has no usable credentials for this request. */
const AUTH_REQUIRED = -32000;

/** A method the agent authenticates by itself (the default type); a `terminal` method needs a person and is never passed to `authenticate`. */
const isAutomatic = (method: AuthMethod): boolean => !("type" in method && method.type === "terminal");

const describeMethods = (offered: AuthMethod[]): string =>
	offered.map((method) => (method.name ? `${method.id} (${method.name})` : method.id)).join(", ");

/** The agent answered `auth_required` and nothing here signed it in: `methods` names what it offers, ids and names only. */
export class AcpAuthRequired extends Error {
	readonly methods: string[];
	constructor(offered: AuthMethod[], cause: unknown) {
		super(
			offered.length
				? `ACP agent requires authentication that needs a person; authenticate with the agent itself (methods: ${describeMethods(offered)}).`
				: "ACP agent requires authentication and offers no method; sign in with the agent itself.",
			{ cause },
		);
		this.name = "AcpAuthRequired";
		this.methods = offered.map((method) => method.name ?? method.id);
	}
}

/** The `AcpAuthRequired` anywhere in `error`'s cause chain: a failed connect wraps it with the phase it failed in. */
export function authRequiredIn(error: unknown): AcpAuthRequired | undefined {
	for (let current = error, depth = 0; current && depth < 8; depth++) {
		if (current instanceof AcpAuthRequired) return current;
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}

/**
 * Runs a session request; when the agent refuses it with `auth_required`, authenticates with the first method that needs
 * no person and runs it once more. When every method needs a person, or `automatic` is false (a sign-in probe must not
 * sign anything in), it throws `AcpAuthRequired` naming them.
 */
export async function withAuthentication<T>(
	connection: ClientConnection,
	offered: AuthMethod[] | undefined,
	signal: AbortSignal,
	request: () => Promise<T>,
	automatic = true,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (!(error instanceof RequestError) || error.code !== AUTH_REQUIRED) throw error;
		const chosen = automatic ? offered?.find(isAutomatic) : undefined;
		if (!chosen) throw new AcpAuthRequired(offered ?? [], error);
		await untilAborted(connection.agent.request(methods.agent.authenticate, { methodId: chosen.id }), signal);
		return request();
	}
}
