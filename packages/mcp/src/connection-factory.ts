/** The one way to build a configured server's connection, for sessions and for `octocode mcp`. */

import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import type { McpOAuthCredentialStore } from "./oauth.ts";
import { type McpInstallOptions, resolveInstalledLaunch } from "./install.ts";
import { McpServerConnection } from "./runtime.ts";
import { createDefaultTransport, type McpTransportFactory } from "./runtime/transport.ts";

export interface McpConnectionOptions {
	entry: McpServerEntry;
	cwd: string;
	credentials: McpOAuthCredentialStore;
	log?: McpServerLog;
	/** The current token of an Octocode provider, for servers with `auth.provider`. */
	providerToken?: (provider: string) => Promise<string | undefined>;
	/** Adjusts the entry just before its server launches, for example to add default roots. */
	prepareLaunch?: (entry: McpServerEntry, cwd: string) => McpServerEntry;
	/** Receives the entry each launch used, after `prepareLaunch`. */
	onLaunch?: (connection: McpServerConnection, launched: McpServerEntry) => void;
	/** Defaults to the stdio and streamable HTTP transports. */
	createTransport?: McpTransportFactory;
	onTools?: (connection: McpServerConnection) => void;
	onChange?: (connection: McpServerConnection) => void;
	/** Installs an entry's `install` package before its launch (`install.ts`); tests inject npm here. */
	install?: Omit<McpInstallOptions, "signal">;
}

export function createServerConnection(options: McpConnectionOptions): McpServerConnection {
	const { prepareLaunch, onLaunch, createTransport = createDefaultTransport, onTools, install, ...rest } = options;
	const connection: McpServerConnection = new McpServerConnection({
		...rest,
		onTools: onTools ?? (() => {}),
		prepareEntry: async (entry, signal) => {
			const launched = prepareLaunch?.(entry, options.cwd) ?? entry;
			onLaunch?.(connection, structuredClone(launched));
			return resolveInstalledLaunch(launched, { ...install, signal });
		},
		createTransport,
	});
	return connection;
}
