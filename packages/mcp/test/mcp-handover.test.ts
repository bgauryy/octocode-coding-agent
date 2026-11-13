import { afterEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { closeHanded, handedCount } from "../src/handover.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import type { McpTransportFactory } from "../src/runtime.ts";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

/** One launched in-memory server: it answers `initialize` and a one-tool catalog until it is stopped. */
interface Launch {
	env: Record<string, string> | undefined;
	closed: boolean;
	crash: () => Promise<void>;
}

function launcher() {
	const launches: Launch[] = [];
	const createTransport: McpTransportFactory = (entry) => {
		const pair = createInMemoryTransportPair();
		const launch: Launch = {
			env: "command" in entry.config ? entry.config.env : undefined,
			closed: false,
			crash: () => pair.server.close(),
		};
		launches.push(launch);
		pair.server.onClose(() => (launch.closed = true));
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "fake", version: "1" },
						}
					: {
							tools: [
								{
									name: "lookup",
									description: "Look a thing up.",
									inputSchema: { type: "object", properties: { q: { type: "string" } } },
								},
							],
						};
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		void pair.server.start();
		return pair.client;
	};
	return { launches, createTransport };
}

const server = (env: Record<string, string> = { MODE: "a" }): McpServerEntry => ({
	name: "kept",
	source: "test",
	scope: "global",
	config: { command: "unused", env },
});

const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
	await Promise.all(closeHanded());
});

/** Hosts of one process: the same host options, as every session of the CLI builds them. */
function process_() {
	const { launches, createTransport } = launcher();
	const shared = {
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		logPath: `${tmp()}/mcp.log`,
		createTransport,
	};
	const cwd = tmp();
	const session = (servers: McpServerEntry[] = [server()]) => {
		const host = mcpHost({ ...shared, cwd, servers });
		hosts.push(host);
		return host;
	};
	return { launches, session };
}

/** What the model is told about the server's tools: names and parameter schemas, in registration order. */
const declared = (host: ReturnType<typeof mcpHost>) =>
	JSON.stringify([...host.tools.values()].map((tool) => [tool.name, tool.description, tool.parameters]));

const replace = (host: ReturnType<typeof mcpHost>, reason: string) =>
	host.fire("session_shutdown", { type: "session_shutdown", reason }, host.ctx);

describe("MCP connections across a session switch", () => {
	it("keeps the server process when the launch is unchanged, with the same tools and prompt", async () => {
		const { launches, session } = process_();
		const first = session();
		await first.start();
		const firstPrompt = await first.prompt();
		const connection = first.state.findServer("kept")?.connection;
		expect(connection?.state).toBe("connected");
		await replace(first, "new");
		expect(handedCount()).toBe(1);
		expect(launches[0]?.closed).toBe(false);

		const second = session();
		await second.start();
		const secondPrompt = await second.prompt();
		expect(launches).toHaveLength(1);
		expect(second.state.findServer("kept")?.connection).toBe(connection);
		expect(handedCount()).toBe(0);
		expect(declared(second)).toBe(declared(first));
		expect(secondPrompt).toEqual(firstPrompt);
		// The adopted connection reports to the new session: a call goes through it.
		const lookup = [...second.tools.keys()].find((name) => name.endsWith("lookup"));
		expect(lookup).toBeDefined();
	});

	it("keeps it across a resume too, and closes it when the last session quits", async () => {
		const { launches, session } = process_();
		const first = session();
		await first.start();
		await first.prompt();
		await replace(first, "resume");
		const second = session();
		await second.start();
		await second.prompt();
		expect(launches).toHaveLength(1);
		await replace(second, "quit");
		expect(handedCount()).toBe(0);
		expect(launches[0]?.closed).toBe(true);
	});

	it("relaunches a server whose launch changed, after the old one stopped", async () => {
		const { launches, session } = process_();
		const first = session([server({ MODE: "a" })]);
		await first.start();
		await first.prompt();
		await replace(first, "new");
		const second = session([server({ MODE: "b" })]);
		await second.start();
		await second.prompt();
		expect(launches.map((launch) => launch.env?.MODE)).toEqual(["a", "b"]);
		expect(launches[0]?.closed).toBe(true);
		expect(second.state.findServer("kept")?.connection?.state).toBe("connected");
	});

	it("relaunches a server that dropped while the sessions switched", async () => {
		const { launches, session } = process_();
		const first = session();
		await first.start();
		await first.prompt();
		await replace(first, "new");
		await launches[0]?.crash();
		const second = session();
		await second.start();
		await second.prompt();
		expect(launches).toHaveLength(2);
		expect(second.state.findServer("kept")?.connection?.state).toBe("connected");
	});

	it("closes a handed connection the next session does not start, and hands nothing over on quit or reload", async () => {
		const { launches, session } = process_();
		const first = session();
		await first.start();
		await first.prompt();
		await replace(first, "new");
		const second = session([]);
		await second.start();
		await new Promise((resolve) => setImmediate(resolve));
		expect(handedCount()).toBe(0);
		expect(launches[0]?.closed).toBe(true);

		for (const reason of ["quit", "reload", undefined]) {
			const next = session();
			await next.start();
			await next.prompt();
			await next.fire("session_shutdown", { type: "session_shutdown", reason }, next.ctx);
			expect(handedCount()).toBe(0);
			expect(launches.at(-1)?.closed).toBe(true);
		}
	});

	it("does not hand over a server the session stopped", async () => {
		const { launches, session } = process_();
		const first = session();
		await first.start();
		await first.prompt();
		await first.state.findServer("kept")?.connection?.stop();
		await replace(first, "new");
		expect(handedCount()).toBe(0);
		const second = session();
		await second.start();
		await second.prompt();
		expect(launches).toHaveLength(2);
	});
});
