import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scriptedArgs } from "./e2e-calls.ts";
import { tmp } from "./helpers.ts";

/**
 * Real CLI processes against a scripted OpenAI-compatible endpoint on loopback, in an isolated `HOME`: no network, no
 * credentials, no fake host. Nothing is faked but the model: the tool registry, the signal handlers, the child processes
 * and the exit code are the ones a user gets.
 *
 * A user message holding `B64SCRIPT:<base64 JSON array>` drives the replies; the step is the number of assistant messages
 * after that message, and the last step repeats. A task handed to a child carries its own script the same way, and
 * `{{CHILD}}` in a step stands for the subagent id the earlier tool results name.
 */
export type Step =
	| { text: string }
	/** `promptTokens` is the prompt size the reply reports, so a test can show a full context without filling one. */
	| { tool: string; args?: Record<string, unknown>; promptTokens?: number }
	/** Never answers, so a test can hold a process inside a request. */
	| { hang: true };

const SUMMARY_TEXT = "scripted summary";
/** What the endpoint answers once the conversation holds its summary: the turn that resumes from a compaction. */
export const RESUMED_TEXT = "resumed from the summary";

export const script = (steps: readonly Step[]): string =>
	`B64SCRIPT:${Buffer.from(JSON.stringify(steps)).toString("base64")}`;

/** One request the endpoint received: the tools declared to the model, and every tool result it was sent. */
export interface ModelRequest {
	at: number;
	/** The script this request answers, which tells a parent's requests from its child's. */
	script: string;
	/** The model id and `reasoning_effort` the request asked for. */
	model: string;
	reasoningEffort?: string;
	/** The system prompt as the model received it. */
	system: string;
	tools: string[];
	/** Each declared tool's description and JSON Schema, by name, as the model received them. */
	declarations: Record<string, { description: string; parameters: unknown }>;
	step: number;
	toolResults: string[];
	lastUserText: string;
	/** Every message's role and text, for what arrives outside a tool result (a child's message to its parent). */
	messages: Array<{ role: string; text: string }>;
}

const text = (message: { content?: unknown }): string =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

export interface Endpoint {
	url: string;
	requests: ModelRequest[];
	close(): Promise<void>;
}

/** The scripted model. In this test process, so a request is an observable event rather than a line in a log file. */
export async function startEndpoint(): Promise<Endpoint> {
	const requests: ModelRequest[] = [];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			// `web` may fetch this address: only a model request is a model request.
			if (request.method !== "POST") return void response.writeHead(404).end();
			const parsed = JSON.parse(body) as {
				model: string;
				reasoning_effort?: string;
				messages: Array<{ role: string; content?: unknown }>;
				tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>;
			};
			const { messages } = parsed;
			let index = -1;
			let source = "";
			let steps: Step[] = [{ text: "no script" }];
			for (let at = messages.length - 1; at >= 0; at--) {
				if (messages[at]?.role !== "user") continue;
				const found = /B64SCRIPT:([A-Za-z0-9+/=]+)/.exec(text(messages[at] ?? {}));
				if (!found) continue;
				index = at;
				source = found[1]!;
				steps = JSON.parse(Buffer.from(source, "base64").toString()) as Step[];
				break;
			}
			const step = index < 0 ? 0 : messages.slice(index + 1).filter((message) => message.role === "assistant").length;
			requests.push({
				at: Date.now(),
				script: source,
				model: parsed.model,
				reasoningEffort: parsed.reasoning_effort,
				system: messages
					.filter((message) => message.role === "system" || message.role === "developer")
					.map(text)
					.join("\n"),
				tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? ""),
				declarations: Object.fromEntries(
					(parsed.tools ?? []).map(({ function: declared }) => [
						declared?.name ?? "",
						{ description: declared?.description ?? "", parameters: declared?.parameters },
					]),
				),
				step,
				toolResults: messages.filter((message) => message.role === "tool").map(text),
				lastUserText: text(messages.findLast((message) => message.role === "user") ?? {}),
				messages: messages.map((message) => ({ role: message.role, text: text(message) })),
			});
			const results = messages.filter((message) => message.role === "tool").map(text);
			const child =
				results.join("\n").match(/(?:Subagent|Started|Queued) (\S+) (?:finished|reported|failed|\()/)?.[1] ?? "none";
			// A compaction summary is the session's own request, and the turn after one has lost count of the script's steps.
			const lastUser = text(messages.findLast((message) => message.role === "user") ?? {});
			const summarized = messages.some((message) => text(message).includes(SUMMARY_TEXT));
			const scripted: Step =
				!parsed.tools?.length || lastUser.includes("context checkpoint summary")
					? { text: SUMMARY_TEXT }
					: summarized
						? { text: RESUMED_TEXT }
						: steps[Math.min(step, steps.length - 1)];
			const current = JSON.parse(JSON.stringify(scripted).replaceAll("{{CHILD}}", child)) as Step;
			response.writeHead(200, { "content-type": "text/event-stream" });
			if ("hang" in current) return;
			const promptTokens = ("promptTokens" in current && current.promptTokens) || 100;
			const usage = { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 };
			const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
				response.write(
					`data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
				);
			if ("tool" in current) {
				const id = `call_${requests.length}`;
				const args = JSON.stringify(scriptedArgs(current.tool, current.args));
				const call = { index: 0, id, type: "function", function: { name: current.tool, arguments: args } };
				chunk({ delta: { role: "assistant", tool_calls: [call] } });
				chunk({ delta: {}, finish_reason: "tool_calls" }, { usage });
			} else {
				chunk({ delta: { role: "assistant", content: current.text } });
				chunk({ delta: {}, finish_reason: "stop" }, { usage });
			}
			response.end("data: [DONE]\n\n");
		});
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const RESOLVER = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface Run {
	process: ChildProcess;
	stdout(): string;
	stderr(): string;
	/** How the process ended; `close`, so its output is complete. */
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface Sandbox {
	root: string;
	home: string;
	project: string;
	env: NodeJS.ProcessEnv;
	/**
	 * A shell command that records its pid in `marker` and runs until stopped. Its command line names the sandbox, so
	 * `survivors` sees it and `killEverything` can reach it even when the run that started it failed to.
	 */
	holdCommand(marker: string): string;
	/** Starts the CLI as a user would, on the scripted model: from source, or the built file at `cli`. */
	start(
		args: readonly string[],
		options?: { stdin?: "pipe" | number; model?: false; cli?: string; trust?: false; subcommand?: true; cwd?: string },
	): Run;
	/** The live processes whose command line names this sandbox: the CLI, its children and their commands. */
	survivors(): number[];
}

const sandboxes: Sandbox[] = [];
const started: Run[] = [];

/**
 * Merges `patch` into the sandbox's global settings file, which `sandbox` starts with `sessionApiTurnPermission: "session"`:
 * these suites exercise the API transport, not the gate that holds a turn an API client starts to `workspace` mode.
 */
export function writeSettings(box: Pick<Sandbox, "home">, patch: Record<string, unknown>): void {
	const file = path.join(box.home, ".octocode", "octocodecode", "settings.json");
	const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
	fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }));
}

/** A fresh `HOME` with a git repository, `models.json` pointing at the endpoint, and no credentials. */
export function sandbox(endpoint: Endpoint): Sandbox {
	const root = fs.realpathSync(tmp("octocode-real-process-"));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	const agentDir = path.join(home, ".octocode", "octocodecode");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				scripted: {
					baseUrl: endpoint.url,
					api: "openai-completions",
					apiKey: "local",
					authHeader: true,
					models: [
						{
							id: "model",
							name: "model",
							contextWindow: 200000,
							maxTokens: 8000,
							input: ["text"],
							cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
						},
					],
				},
			},
		}),
	);
	// The scripted model answers many requests from one process: the product's per-session request window is off here
	// (`request-rate.test.ts` covers it).
	writeSettings({ home }, { sessionApiTurnPermission: "session", requestsPerMinute: 0 });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	fs.writeFileSync(path.join(project, "a.txt"), "hi\n");
	git("add", ".");
	git("commit", "-qm", "init");
	// Only what a process needs: this suite's own OCTOCODE_* and credentials stay out, and the home is the sandbox's.
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		PATH: process.env.PATH,
		TMPDIR: process.env.TMPDIR,
		// Booting from source is most of a process's cost: see setup-env.ts.
		NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_SKIP_VERSION_CHECK: "1",
		OCTOCODE_MODELS_DEV: "0",
		// The research server is the sibling repository's build; the MCP feature and the `mcp` tool stay.
		OCTOCODE_MCP: "0",
		// A session that runs `/web` gives the page's address and opens no window on this machine.
		OCTOCODE_OPEN_BROWSER: "0",
	};
	const holder = path.join(root, "hold.cjs");
	fs.writeFileSync(
		holder,
		'require("node:fs").writeFileSync(process.argv[2], String(process.pid));setInterval(() => {}, 60000);\n',
	);
	const box: Sandbox = {
		root,
		home,
		project,
		env,
		holdCommand: (marker) => `${JSON.stringify(process.execPath)} ${JSON.stringify(holder)} ${JSON.stringify(marker)}`,
		start(args, options) {
			const child = spawn(
				process.execPath,
				[
					"--no-warnings",
					...(options?.cli ? [options.cli] : ["--import", RESOLVER, CLI]),
					// A subcommand takes its arguments alone: flags before it would make them a prompt.
					...(options?.subcommand
						? []
						: [
								...(options?.trust === false ? [] : ["--trust"]),
								"--offline",
								...(options?.model === false ? [] : ["--model", "scripted/model"]),
							]),
					...args,
				],
				{ cwd: options?.cwd ?? project, env, stdio: [options?.stdin ?? "ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => (stdout += chunk));
			child.stderr?.on("data", (chunk) => (stderr += chunk));
			const run: Run = {
				process: child,
				stdout: () => stdout,
				stderr: () => stderr,
				exited: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
			};
			started.push(run);
			return run;
		},
		survivors: () => processesNaming(root),
	};
	sandboxes.push(box);
	return box;
}

/** A `ps` scan: a child's arguments name its session folder under the sandbox, and a script's command names its markers. */
function processesNaming(needle: string): number[] {
	// A busy machine lists more than execFileSync's 1 MB default (ENOBUFS).
	const listing = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const found = listing
		.split("\n")
		.map((line) => ({ line: line.trim(), pid: Number.parseInt(line.trim(), 10) }))
		.filter(({ line, pid }) => line.includes(needle) && Number.isInteger(pid) && pid !== process.pid);
	lastSurvivors = found.map(({ line }) => line);
	return found.map(({ pid }) => pid);
}

/** The `pid command` lines of the latest `survivors()` scan, so a timed-out wait can name what is still running. */
let lastSurvivors: string[] = [];

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Waits for a condition a real process will reach; only the test's own timeout bounds it. */
export async function until(
	condition: () => boolean,
	label: string,
	ms = 120_000,
	describe: () => string = () => (label.includes("process") ? lastSurvivors.join("\n") : ""),
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) {
			const detail = describe();
			throw new Error(`Timed out waiting for ${label}${detail ? `. Still running:\n${detail}` : ""}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Reads a pid a scripted command wrote to its marker file. */
export function pidFrom(file: string): number {
	return Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
}

/** What the processes of a failed test wrote, since that is usually why. */
export function outputOfRuns(): string {
	return started.map((run) => `--- stdout\n${run.stdout()}\n--- stderr\n${run.stderr()}`).join("\n");
}

/** Kills everything the suite started and waits, bounded, until each process is gone, so a caller can remove the folders they used. */
export async function killEverything(waitMs = 10_000): Promise<void> {
	const exits: Promise<void>[] = [];
	for (const run of started.splice(0)) {
		const child = run.process;
		if (child.exitCode !== null || child.signalCode !== null) continue;
		exits.push(new Promise((resolve) => child.once("exit", () => resolve())));
		child.kill("SIGKILL");
	}
	const orphans = new Set<number>();
	for (const box of sandboxes.splice(0)) {
		for (const pid of box.survivors()) {
			orphans.add(pid);
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	const deadline = Date.now() + waitMs;
	await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, waitMs))]);
	while ([...orphans].some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}
