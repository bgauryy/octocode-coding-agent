/** `pi mcp login`: the OAuth sign-in through the browser, with a pasted redirect URL as fallback. */

import { createInterface } from "node:readline/promises";
import { openBrowser } from "../../../utils/open-browser.ts";
import type { McpServerEntry } from "../config.ts";
import {
	type McpOAuthCredentialStore,
	type McpServerConnection,
	McpSignInCancelledError,
	signInMcpServer,
} from "../runtime.ts";
import { errorMessage, type McpCommandOptions } from "./shared.ts";

export async function login(
	entry: McpServerEntry,
	connection: McpServerConnection,
	url: string,
	timeoutMs: number,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const { name } = entry;
	// Connecting first answers whether a sign-in is needed and records the server's challenge.
	try {
		await connection.getClient();
		log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
		return 0;
	} catch {
		if (connection.state !== "needs-auth") {
			error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
			return 1;
		}
	}

	const openUrl = options.openUrl ?? openBrowser;
	const interactive = process.stdin.isTTY && options.openUrl === undefined;
	try {
		await signInMcpServer({
			serverUrl: url,
			store: credentials.forServer(name, url),
			settings: connection.oauthSettings(),
			challenge: connection.challenge,
			prompt: {
				showAuthorizationUrl: (authorizationUrl) => {
					log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
					openUrl(authorizationUrl.href);
				},
				promptForRedirectUrl: (signal) => waitForRedirectUrl(signal, interactive),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (signInError) {
		error(
			signInError instanceof McpSignInCancelledError
				? `Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(timeoutMs / 1000)} seconds.`
				: `Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`,
		);
		return 1;
	}
	connection.challenge = undefined;
	try {
		await connection.reconnect();
	} catch (connectError) {
		error(`Signed in, but ${errorMessage(connectError)}`);
		return 1;
	}
	log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
	return 0;
}

/**
 * The pasted redirect URL in a terminal; otherwise only the browser callback can finish the sign-in.
 * Resolves to undefined when `signal` aborts: the callback arrived, or the sign-in timed out.
 */
async function waitForRedirectUrl(signal: AbortSignal, interactive: boolean): Promise<string | undefined> {
	if (!interactive) {
		if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		return undefined;
	}
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await readline.question("If the browser cannot reach this machine, paste the URL it was redirected to: ", {
			signal,
		});
	} catch {
		return undefined;
	} finally {
		readline.close();
	}
}
