import { type AuthMethod, type ClientConnection, methods, RequestError } from "@agentclientprotocol/sdk";
import { untilAborted } from "@octocodeai/octocode-common/abort";

/** ACP's `auth_required` code: the agent has no usable credentials for this request. */
const AUTH_REQUIRED = -32000;

/** A method the agent authenticates by itself (the default type); a `terminal` method needs a person and is never passed to `authenticate`. */
const isAutomatic = (method: AuthMethod): boolean => !("type" in method && method.type === "terminal");

const describeMethods = (offered: AuthMethod[]): string =>
	offered.map((method) => (method.name ? `${method.id} (${method.name})` : method.id)).join(", ");

/**
 * Runs a session request; when the agent refuses it with `auth_required`, authenticates with the first method that needs
 * no person and runs it once more. When every method needs a person, the error names them.
 */
export async function withAuthentication<T>(
	connection: ClientConnection,
	offered: AuthMethod[] | undefined,
	signal: AbortSignal,
	request: () => Promise<T>,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (!(error instanceof RequestError) || error.code !== AUTH_REQUIRED || !offered?.length) throw error;
		const automatic = offered.find(isAutomatic);
		if (!automatic)
			throw new Error(
				`ACP agent requires authentication that needs a person; authenticate with the agent itself (methods: ${describeMethods(offered)}).`,
				{ cause: error },
			);
		await untilAborted(connection.agent.request(methods.agent.authenticate, { methodId: automatic.id }), signal);
		return request();
	}
}
