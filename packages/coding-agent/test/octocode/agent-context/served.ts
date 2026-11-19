import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpInstallDir } from "../../../../mcp/src/install.ts";
import freellamaPreset from "../../../../mcp/src/recommended/freellama.json" with { type: "json" };

/**
 * The first request as a user's home serves it, for the size guard (`served-first-request.test.ts`): the recommended
 * FreeLlama preset on (a user who opted in), the octocode-mcp tools declared as a workspace that has used
 * its research tools declares them (`mcpExposure: "usage"`, the default, promoting them), and a model whose transport cannot add tools
 * mid-conversation, so every on-demand tool is declared deferred.
 */

/** The server and its tool list as FreeLlama's package serves them, recorded once from the version the preset installs. */
const RECORDING = fileURLToPath(new URL("./fixtures/freellama-server.json", import.meta.url));

export interface FreellamaRecording {
	version: string;
	serverInfo: { name: string; version: string };
	instructions: string;
	tools: unknown[];
}

export const readFreellamaRecording = (): FreellamaRecording =>
	JSON.parse(fs.readFileSync(RECORDING, "utf8")) as FreellamaRecording;

/** The octocode-mcp tools sessions use often: declared in full under `usage` (and, called in the last day, `recent`). */
export const SERVED_RECENT_TOOLS = [
	"localSearch",
	"localFetch",
	"structureSearch",
	"astSearch",
	"lspSearch",
	"clasify",
].map((tool) => `octocode/${tool}`);

/** An AGENTS.md of the size a real project has (a pinned copy of this repository's), so the `project_context` layer is not a few lines. */
export const SERVED_PROJECT_INSTRUCTIONS = fs.readFileSync(
	fileURLToPath(new URL("./fixtures/project-instructions.md", import.meta.url)),
	"utf8",
);

/** A stdio MCP server that answers `initialize` and `tools/list` from the recording, so FreeLlama needs no install or network. */
const REPLAY_SERVER = `
import fs from "node:fs";
import readline from "node:readline";
const recording = JSON.parse(fs.readFileSync(new URL("./recording.json", import.meta.url), "utf8"));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	if (message.method === "initialize")
		reply(message.id, {
			protocolVersion: message.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: recording.serverInfo,
			instructions: recording.instructions,
		});
	else if (message.method === "tools/list") reply(message.id, { tools: recording.tools });
	else reply(message.id, {});
});
`;

/**
 * Installs the recording where the preset's install step looks (`mcpInstallDir`), so the preset launches it as the real
 * package: the folder holds a manifest of the preset's version and a bin that replays the recording.
 */
export function installFreellamaReplay(agentDir: string): void {
	const { npm, version, bin } = freellamaPreset.install;
	const recording = readFreellamaRecording();
	if (recording.version !== version)
		throw new Error(
			`The FreeLlama recording is of ${recording.version}; the preset installs ${version}. Record the new version's initialize and tools/list into fixtures/freellama-server.json and re-pin the served ceilings.`,
		);
	const dir = path.join(mcpInstallDir(agentDir, freellamaPreset.name), "node_modules", ...npm.split("/"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: npm, version, bin: { [bin]: "server.mjs" } }),
	);
	fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify(recording));
	fs.writeFileSync(path.join(dir, "server.mjs"), REPLAY_SERVER);
}

/**
 * What a session reads to promote `SERVED_RECENT_TOOLS`: the usage snapshot of each role group (`usage`, the default) and
 * the workspace's record of tools called in the last day (`recent`; a child takes the set from its environment instead).
 * `scopes` are the working directory's spellings.
 */
export function writeRecentUse(agentDir: string, scopes: readonly string[]): void {
	const at = Date.now();
	const tools = Object.fromEntries(SERVED_RECENT_TOOLS.map((tool) => [tool, at]));
	fs.writeFileSync(
		path.join(agentDir, "tool-use.json"),
		JSON.stringify(Object.fromEntries(scopes.map((scope) => [scope, tools]))),
	);
	const snapshot = { at, tools: [...SERVED_RECENT_TOOLS].sort() };
	fs.writeFileSync(
		path.join(agentDir, "tool-usage.json"),
		JSON.stringify({ days: {}, snapshots: { main: snapshot, subagent: snapshot } }),
	);
}
