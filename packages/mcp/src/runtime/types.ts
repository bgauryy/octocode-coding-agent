import type { McpServerEntry } from "../config.ts";
import type { McpServerLog } from "../log.ts";
import type { McpOAuthCredentialStore } from "../oauth.ts";
import type { McpServerConnection } from "../runtime.ts";
import type { McpTransportFactory } from "./transport.ts";

export interface McpRuntimeOptions {
	entry: McpServerEntry;
	cwd: string;
	createTransport: McpTransportFactory;
	credentials: McpOAuthCredentialStore;
	providerToken?: (provider: string) => Promise<string | undefined>;
	onTools: (connection: McpServerConnection) => void;
	onChange?: (connection: McpServerConnection) => void;
	log?: McpServerLog;
}
