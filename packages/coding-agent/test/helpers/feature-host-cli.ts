import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCliInvocation } from "../../src/config.ts";
import { stopTree } from "../../src/octocode/shared/process.ts";
import { leadsProcessGroup } from "../../src/utils/shell.ts";
import { trustFolder } from "../octocode/helpers.ts";
import { compileCacheEnv } from "./compile-cache.ts";

/**
 * Real-process fixtures for the feature host's entry points (CLI, RPC and ACP): an isolated HOME, agent directory and
 * agent database, a project folder the user trusted, and a scripted model reached over HTTP. Nothing here replaces
 * product code; the only fake is the model endpoint a user would otherwise pay for.
 */
export interface Sandbox {
	/** The temporary root, which is also HOME. */
	directory: string;
	/** The trusted project folder (a subfolder: Octocode refuses to open or trust a home folder). */
	project: string;
	agentDir: string;
	env: Record<string, string>;
	cleanup(): void;
}

/** A sandbox whose child processes see only this environment; `extraEnv` adds to it. */
export function createSandbox(extraEnv: Record<string, string> = {}): Sandbox {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "octocode-feature-host-")));
	const project = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(project);
	mkdirSync(agentDir);
	const env: Record<string, string> = {
		PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
		HOME: directory,
		USERPROFILE: directory,
		TMPDIR: tmpdir(),
		OCTOCODE_HOME: join(directory, "octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MCP: "0",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_INTERNAL_ACP_WORKER: "0",
		// A process exits only after writing the compile cache entries it lacked: without the suite's shared cache that is
		// every module, seconds under load.
		...compileCacheEnv(),
		...extraEnv,
	};
	trustFolder(project, env);
	return {
		directory,
		project,
		agentDir,
		env,
		// A child's last write can land while the tree is removed on a loaded machine (ENOTEMPTY): remove again shortly.
		cleanup: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
	};
}

/** Writes the user's global `settings.json`. */
export function writeSettings(sandbox: Sandbox, settings: Record<string, unknown>): void {
	writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify(settings));
}

/** Arguments every child run takes: no ambient resources, no network. */
export const QUIET_ARGS = ["--no-skills", "--no-context-files", "--offline"];

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Ends a child spawned with `detached: leadsProcessGroup()` and everything it started, and resolves once the tree is
 * gone: a grandchild left running would still write into the sandbox while `cleanup` removes it (ENOTEMPTY).
 */
export async function stopChildTree(child: { pid?: number }): Promise<void> {
	await stopTree(child.pid, 2000);
}

/** Runs the source CLI to completion in the sandbox's project folder. */
export async function runCli(sandbox: Sandbox, args: string[], timeoutMs = 60_000): Promise<CliResult> {
	const invocation = getCliInvocation();
	const child = spawn(invocation.command, [...invocation.prefix, ...args], {
		cwd: sandbox.project,
		env: sandbox.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: leadsProcessGroup(),
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
	const timer = setTimeout(() => void stopChildTree(child), timeoutMs);
	try {
		const [code] = (await once(child, "close")) as [number | null];
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
		await stopChildTree(child);
	}
}

/** One scripted model reply: assistant text, a call to a tool, or a provider failure (an HTTP status and error message). */
type ScriptedReply =
	| { text: string }
	| { tool: string; args: Record<string, unknown> }
	| { status: number; error: string };

export interface ModelServer {
	url: string;
	/** The request bodies the model received, newest last. */
	requests: unknown[];
	/** From now on a request is received but not answered until `release()`; a request the client aborts is dropped. */
	hold(): void;
	release(): void;
	close(): Promise<void>;
}

const chunk = (delta: Record<string, unknown>, finish: string | null) =>
	`data: ${JSON.stringify({
		id: "scripted",
		object: "chat.completion.chunk",
		created: 0,
		model: "scripted",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

/**
 * An OpenAI-compatible chat endpoint that answers each request with the next scripted reply, then "done" for any later
 * request. The CLI reaches it through a `models.json` provider (`writeScriptedProvider`).
 */
export async function startModelServer(script: readonly ScriptedReply[]): Promise<ModelServer> {
	const requests: unknown[] = [];
	let next = 0;
	let held: PromiseWithResolvers<void> | undefined;
	const server: Server = createServer((request, response) => {
		const body: Buffer[] = [];
		request.on("data", (part) => body.push(part));
		request.on("end", async () => {
			try {
				requests.push(JSON.parse(Buffer.concat(body).toString() || "null"));
			} catch {
				requests.push(null);
			}
			const gate = held?.promise;
			if (gate) {
				const closed = new Promise<void>((resolve) => response.on("close", resolve));
				await Promise.race([gate, closed]);
				if (response.destroyed) return;
			}
			const reply: ScriptedReply = script[next++] ?? { text: "done" };
			if ("status" in reply) {
				response.writeHead(reply.status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: reply.error, type: "scripted_failure" } }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(chunk({ role: "assistant" }, null));
			if ("text" in reply) {
				response.write(chunk({ content: reply.text }, null));
				response.write(chunk({}, "stop"));
			} else {
				const call = {
					index: 0,
					id: `call_${next}`,
					type: "function",
					function: {
						name: reply.tool,
						arguments: JSON.stringify({ reason: "scripted entry-point step", ...reply.args }),
					},
				};
				response.write(chunk({ tool_calls: [call] }, null));
				response.write(chunk({}, "tool_calls"));
			}
			response.end("data: [DONE]\n\n");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a local test port");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		requests,
		hold: () => {
			held ??= Promise.withResolvers<void>();
		},
		release: () => {
			held?.resolve();
			held = undefined;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

/** Provider and model names `writeScriptedProvider` defines, and the arguments that select them. */
export const SCRIPTED_MODEL_ARGS = ["--provider", "scripted", "--model", "scripted"];

/** Defines the `scripted` provider in the sandbox's `models.json`, pointing at `server`. */
export function writeScriptedProvider(sandbox: Pick<Sandbox, "agentDir">, server: ModelServer): void {
	writeFileSync(
		join(sandbox.agentDir, "models.json"),
		JSON.stringify({
			providers: {
				scripted: {
					baseUrl: server.url,
					api: "openai-completions",
					apiKey: "scripted-key",
					models: [
						{
							id: "scripted",
							name: "Scripted",
							reasoning: false,
							input: ["text"],
							contextWindow: 128_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
		{ mode: 0o600 },
	);
}

/** Process ids the lifecycle hooks of `observeSessions` recorded, one per line in each file. */
export interface SessionObserver {
	/** Each `SessionStart`: the pid of the process that runs the session (an ACP worker, or the RPC/CLI process). */
	started(): number[];
	/** Each `SessionEnd`, in the same terms. */
	ended(): number[];
}

/**
 * Registers `SessionStart` and `SessionEnd` command hooks in the sandbox's `~/.claude/settings.json` that append the pid of the
 * process running the session to a file: what a test reads to see which process started or shut down a session. The
 * hook shell's parent is that process. POSIX only (`$PPID`). The Claude harness is off until switched on (`/harness`),
 * so this also sets `harness:claude` in the user's global settings, keeping what the file already holds.
 */
export function observeSessions(sandbox: Pick<Sandbox, "directory" | "env" | "agentDir">): SessionObserver {
	const startedFile = join(sandbox.directory, "session-started.txt");
	const endedFile = join(sandbox.directory, "session-ended.txt");
	const record = (file: string) => ({ hooks: [{ type: "command", command: `echo $PPID >> "${file}"` }] });
	// Claude's user settings: the `SessionEnd` hooks the host runs at shutdown are the Claude-protocol ones.
	const claude = join(sandbox.env.HOME, ".claude");
	mkdirSync(claude, { recursive: true });
	writeFileSync(
		join(claude, "settings.json"),
		JSON.stringify({ hooks: { SessionStart: [record(startedFile)], SessionEnd: [record(endedFile)] } }),
	);
	const settingsPath = join(sandbox.agentDir, "settings.json");
	const settings = existsSync(settingsPath)
		? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
		: {};
	const toggles = { ...(settings.toggles as Record<string, boolean> | undefined), "harness:claude": true };
	writeFileSync(settingsPath, JSON.stringify({ ...settings, toggles }));
	const read = (file: string) =>
		existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
	return { started: () => read(startedFile), ended: () => read(endedFile) };
}
