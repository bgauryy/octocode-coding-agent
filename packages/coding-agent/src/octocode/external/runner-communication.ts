import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The task owner's single, scoped communication server; it owns the token and server lifetime. */
export interface RunnerCommunication {
	name: string;
	url: string;
	headers: readonly { name: string; value: string }[];
}

/** Installed adapter probes verified HTTP MCP injection; ambient isolation is a separate vendor capability. */
export const runnerSupportsCommunication = (runner: string): boolean =>
	["claude-code", "codex", "opencode", "gemini"].includes(runner);

export function checkRunnerCommunication(runner: string, server?: RunnerCommunication): void {
	if (!server) return;
	if (!runnerSupportsCommunication(runner)) throw new Error(`${runner} has no verified communication bridge.`);
	if (!/^[a-zA-Z0-9_-]+$/.test(server.name)) throw new Error("Invalid runner communication server name.");
}

/** Headless Claude takes a private configuration path, keeping the bearer token out of process arguments. */
export async function withCommunicationConfig<T>(
	server: RunnerCommunication | undefined,
	run: (args: string[]) => Promise<T>,
): Promise<T> {
	if (!server) return run([]);
	const directory = await mkdtemp(path.join(tmpdir(), "octocode-runner-mcp-"));
	try {
		const config = path.join(directory, "mcp.json");
		await writeFile(
			config,
			JSON.stringify({
				mcpServers: {
					[server.name]: {
						type: "http",
						url: server.url,
						headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
					},
				},
			}),
			{ mode: 0o600 },
		);
		return await run(["--mcp-config", config, "--allowedTools", `mcp__${server.name}__*`]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
