import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type McpServer, RequestError } from "@agentclientprotocol/sdk";
import { getAgentDir, isBunBinary } from "../../../coding-agent/src/config.ts";
import { mcpNamespace } from "../../../mcp/src/servers.ts";
import { loadMcpConfig } from "../../../mcp/src/config.ts";

interface ServerDefinition {
	name: string;
	namespace: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	type?: "http";
	url?: string;
	headers?: Record<string, string>;
}

export interface AcpMcpServers {
	args: string[];
	/** Call after the worker's get_state succeeds, before exposing the session. */
	verify(): Promise<void>;
	/** Stop the worker before removing files needed by its MCP processes. */
	cleanup(): Promise<void>;
}

// Static code reads data from a private manifest. ACP values never become JS, shell text,
// or the native configuration's ${VAR}/!command expansion language.
const LAUNCHER = `import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const server = manifest.servers[Number(process.argv[3])];
const child = spawn(server.command, server.args, {
  cwd: manifest.cwd,
  env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
let stopping = false;
let timer;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.stdin.destroy();
  child.kill(signal);
  timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  timer.unref();
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(signal));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
process.stdin.on("end", () => stop());
process.stdin.on("error", () => stop());
process.stdout.on("error", () => stop());
child.stdin.on("error", () => stop());
child.once("error", (error) => {
  process.stderr.write("ACP MCP server failed: " + error.message + "\\n");
  process.exitCode = 1;
  process.stdin.destroy();
});
child.once("close", (code) => {
  clearTimeout(timer);
  process.stdin.destroy();
  process.exitCode = code ?? 1;
});
`;

const EXTENSION = `import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const manifestPath = fileURLToPath(new URL("manifest.json", import.meta.url));
const readyPath = fileURLToPath(new URL("ready.json", import.meta.url));
const launcherPath = fileURLToPath(new URL("launcher.mjs", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const namespace = (name) => "mcp__" + name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/-/g, "_");
const report = (value) => writeFileSync(readyPath, JSON.stringify(value), { mode: 0o600 });
export default function(api) {
  try {
    const occupied = new Set(api.getMcpServers().map((server) => namespace(server.name)));
    for (const [index, server] of manifest.servers.entries()) {
      if (occupied.has(namespace(server.namespace))) throw new Error("ACP MCP namespace already registered: " + server.namespace);
      occupied.add(namespace(server.namespace));
      const common = { description: "ACP client MCP server: " + server.name, exposure: "direct" };
      api.registerMcpServer(server.namespace, server.url
        ? { ...common, type: "http", url: server.url, headers: server.headers, literalHeaders: true }
        : { ...common, command: manifest.runtime, args: [launcherPath, manifestPath, String(index)], cwd: manifest.cwd });
    }
    api.on("session_start", () => report({ ready: true }));
  } catch (error) {
    report({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
`;

function invalid(message: string): never {
	throw RequestError.invalidParams(undefined, message);
}

function definitions(servers: McpServer[]): ServerDefinition[] {
	const names = new Set<string>();
	const namespaces = new Set<string>();
	return servers.map((server) => {
		const type: unknown = "type" in server ? server.type : undefined;
		if (type === "acp") invalid("Experimental ACP-channel MCP transport is unsupported.");
		if (type === "sse") invalid("Legacy SSE MCP transport is unsupported; use Streamable HTTP.");
		if (!server.name.trim() || server.name.includes("\0"))
			invalid("MCP server names must be non-empty and contain no NUL.");
		if (names.has(server.name)) invalid(`Duplicate ACP MCP server name: ${server.name}`);
		names.add(server.name);
		const namespace = `acp_${createHash("sha256").update(server.name).digest("hex").slice(0, 16)}`;
		if (namespaces.has(namespace)) invalid("ACP MCP server names produce a duplicate namespace.");
		namespaces.add(namespace);
		if (!("command" in server)) {
			if (!("url" in server)) invalid("Unsupported ACP MCP transport.");
			if (!URL.canParse(server.url)) invalid("MCP URL must use http or https without credentials or fragment.");
			const url = new URL(server.url);
			if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash)
				invalid("MCP URL must use http or https without credentials or fragment.");
			const headerNames = new Set<string>();
			for (const { name, value } of server.headers) {
				if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value))
					invalid("MCP HTTP header contains an invalid name or value.");
				if (headerNames.has(name.toLowerCase())) invalid(`Duplicate MCP HTTP header: ${name}`);
				headerNames.add(name.toLowerCase());
			}
			const headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
			return { name: server.name, namespace, type: "http" as const, url: server.url, headers };
		}
		if (!isAbsolute(server.command) || server.command.includes("\0"))
			invalid("MCP commands must be absolute paths without NUL.");
		if (server.args.some((arg) => arg.includes("\0"))) invalid("MCP arguments must not contain NUL.");
		const envNames = new Set<string>();
		for (const { name, value } of server.env) {
			if (!name || /[=\0]/.test(name) || value.includes("\0"))
				invalid("MCP environment entries contain an invalid name or value.");
			const key = process.platform === "win32" ? name.toUpperCase() : name;
			if (envNames.has(key)) invalid(`Duplicate MCP environment variable: ${name}`);
			envNames.add(key);
		}
		return { name: server.name, namespace, command: server.command, args: [...server.args], env: [...server.env] };
	});
}

/** Session-local MCP registrations; no user or workspace configuration is written. */
export async function prepareAcpMcpServers(servers: McpServer[], cwd: string): Promise<AcpMcpServers> {
	if (servers.length === 0) return { args: [], verify: async () => {}, cleanup: async () => {} };
	if (!isAbsolute(cwd)) invalid("ACP MCP working directory must be absolute.");
	const requested = definitions(servers);
	// Read every candidate config without executing it. Refuse collisions even in currently
	// untrusted project config: a later trust change must not substitute another server.
	const configured = loadMcpConfig({ agentDir: getAgentDir(), cwd, projectTrusted: true });
	const occupied = new Set(configured.servers.map((server) => mcpNamespace(server.name)));
	for (const server of requested)
		if (occupied.has(mcpNamespace(server.namespace)))
			invalid(`ACP MCP namespace is already configured: ${server.namespace}`);
	const directory = await mkdtemp(join(tmpdir(), "octocode-acp-mcp-"));
	const cleanup = () => rm(directory, { recursive: true, force: true });
	try {
		await chmod(directory, 0o700);
		await writeFile(
			join(directory, "manifest.json"),
			JSON.stringify({ cwd, runtime: isBunBinary ? "node" : process.execPath, servers: requested }),
			{ mode: 0o600 },
		);
		await writeFile(join(directory, "launcher.mjs"), LAUNCHER, { mode: 0o600 });
		await writeFile(join(directory, "extension.mjs"), EXTENSION, { mode: 0o600 });
		return {
			// Client servers explicitly opt into the shared host, even with --no-extensions.
			args: ["--extension", join(directory, "extension.mjs"), "--extension", "builtin:mcp"],
			async verify() {
				let state: { ready?: boolean; error?: string };
				try {
					state = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
				} catch {
					throw new Error("ACP MCP registration did not initialize; the worker must load its session extension.");
				}
				if (state.ready !== true) throw new Error(state.error ?? "ACP MCP registration failed.");
			},
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
