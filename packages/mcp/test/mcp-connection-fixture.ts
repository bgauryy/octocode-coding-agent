import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { StdioTransport } from "../src/client/index.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { McpServerConnection } from "../src/runtime.ts";

/** A stdio server process to start. */
interface Launch {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export function connectionFixture(options: {
	launch: (cwd: string) => Launch;
	cwd?: string;
	timeoutMs?: number;
	onTools?: (connection: McpServerConnection) => void;
	onChange?: (connection: McpServerConnection) => void;
}) {
	return new McpServerConnection({
		entry: {
			name: "fixture",
			source: "test",
			config: { command: "fixture", timeout: (options.timeoutMs ?? 5_000) / 1000 },
		},
		cwd: options.cwd ?? process.cwd(),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		createTransport: (_entry, cwd) => new StdioTransport({ ...options.launch(cwd), stderr: "pipe" }),
		onTools: options.onTools ?? (() => {}),
		onChange: options.onChange,
	});
}
