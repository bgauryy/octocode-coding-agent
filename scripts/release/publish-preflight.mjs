import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "../lib/npm-command.mjs";

/** The research tools this version is built around (the `roles` of `octocode` in `packages/mcp/src/default_mcp_config.json`, `subagents/core-tools.ts`). */
const REQUIRED_RESEARCH_TOOLS = ["localFetch", "localSearch", "structureSearch", "astSearch", "lspSearch"];
const TOOL_PREFIX = "mcp__octocode__";
const FINAL_TEXT = "PREFLIGHT-FINAL";
const BASH_COMMAND = "echo preflight-$((40+2)) | cat";
const BASH_OUTPUT = "preflight-42";
const SESSION_TIMEOUT_MS = 180_000;
// A 1x1 PNG.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function completionChunks(request) {
	const chunk = (choice) => ({
		id: "preflight",
		object: "chat.completion.chunk",
		created: 1,
		model: "preflight",
		choices: [choice],
	});
	const answered = (request.messages ?? []).some((message) => message.role === "tool");
	if (answered) {
		return [
			chunk({ index: 0, delta: { role: "assistant", content: FINAL_TEXT }, finish_reason: null }),
			chunk({ index: 0, delta: {}, finish_reason: "stop" }),
		];
	}
	const call = { name: "bash", arguments: JSON.stringify({ command: BASH_COMMAND, reason: "publish preflight" }) };
	return [
		chunk({
			index: 0,
			delta: { role: "assistant", tool_calls: [{ index: 0, id: "preflight-1", type: "function", function: call }] },
			finish_reason: null,
		}),
		chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }),
	];
}

/** An OpenAI-compatible server scripted to call `bash` once and then answer; it records every request. */
function startScriptedModel() {
	const requests = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (data) => (body += data));
		request.on("end", () => {
			const parsed = JSON.parse(body || "{}");
			requests.push(parsed);
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const chunk of completionChunks(parsed)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, server }));
	});
}

function runCli(entry, args, options) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [entry, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		const timer = setTimeout(() => child.kill("SIGKILL"), SESSION_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * A real session from the installed package against a scripted model: startup, the SQLite database, the research server,
 * the bash parser and a tool round trip. Returns the failures, empty on success.
 */
async function runSessionCheck(consumerDirectory) {
	const scratch = mkdtempSync(join(tmpdir(), "octocode-publish-session-"));
	const model = await startScriptedModel();
	try {
		const agentDirectory = join(scratch, ".octocode", "agent");
		const workspace = join(scratch, "workspace");
		mkdirSync(agentDirectory, { recursive: true });
		mkdirSync(workspace);
		writeFileSync(
			join(agentDirectory, "models.json"),
			JSON.stringify({
				providers: {
					preflight: {
						baseUrl: `http://127.0.0.1:${model.port}/v1`,
						api: "openai-completions",
						apiKey: "preflight",
						models: [{ id: "preflight" }],
					},
				},
			}),
		);
		const entry = join(consumerDirectory, "node_modules", codingAgentName, "dist/bundle/cli.js");
		const result = await runCli(entry, ["-p", "run it", "--trust", "--provider", "preflight", "--model", "preflight"], {
			cwd: workspace,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				USERPROFILE: scratch,
				OCTOCODE_CODING_AGENT_DIR: agentDirectory,
				OCTOCODE_TELEMETRY: "0",
			},
		});
		const failures = [];
		if (result.code !== 0) failures.push(`session exited with ${result.code}: ${result.stderr.slice(0, 400)}`);
		if (!result.stdout.includes(FINAL_TEXT)) failures.push("session did not print the model's answer");
		const tools = (model.requests[0]?.tools ?? []).map((tool) => tool.function?.name);
		const missing = REQUIRED_RESEARCH_TOOLS.filter((name) => !tools.includes(`${TOOL_PREFIX}${name}`));
		if (missing.length > 0)
			failures.push(`the installed octocode-mcp lacks tools this version needs: ${missing.join(", ")}`);
		const toolResult = model.requests.at(-1)?.messages?.findLast?.((message) => message.role === "tool")?.content;
		if (!JSON.stringify(toolResult ?? "").includes(BASH_OUTPUT))
			failures.push(`bash tool did not run: ${JSON.stringify(toolResult ?? null).slice(0, 200)}`);
		return failures;
	} finally {
		model.server.close();
		rmSync(scratch, { force: true, recursive: true });
	}
}

/** The bundle started as its own image worker, with the installed image library. Returns the failures. */
function runImageWorkerCheck(consumerDirectory) {
	const bundle = join(consumerDirectory, "node_modules", codingAgentName, "dist/bundle/octocode.js");
	return new Promise((resolve) => {
		const worker = new Worker(bundle, { workerData: "octocode:image-resize-worker" });
		const finish = (failures) => {
			clearTimeout(timer);
			void worker.terminate();
			resolve(failures);
		};
		const timer = setTimeout(() => finish(["image worker did not answer"]), 30_000);
		worker.on("error", (error) => finish([`image worker failed: ${error.message}`]));
		worker.on("message", (message) => {
			if (message?.type !== "octocode:image-resize-response") return;
			finish(message.result?.data ? [] : [`image worker returned no image: ${message.error ?? "no result"}`]);
		});
		worker.postMessage({ inputBytes: new Uint8Array(Buffer.from(TINY_PNG, "base64")), mimeType: "image/png" });
	});
}

/** This platform's native terminal helper is present, and loads where it needs no display server. */
function findNativeHelperProblems(consumerDirectory, platform = process.platform, arch = process.arch) {
	const directory = join(
		consumerDirectory,
		"node_modules",
		codingAgentName,
		"dist/native",
		platform,
		"prebuilds",
		`${platform}-${arch}`,
	);
	if (!existsSync(directory)) return [`no native terminal helper for ${platform}-${arch}`];
	const addons = readdirSync(directory).filter((name) => name.endsWith(".node"));
	if (addons.length === 0) return [`no native terminal helper in ${directory}`];
	if (platform !== "darwin" && platform !== "win32") return [];
	const require = createRequire(import.meta.url);
	return addons.flatMap((addon) => {
		try {
			require(join(directory, addon));
			return [];
		} catch (error) {
			return [`native terminal helper ${addon} does not load: ${error.message}`];
		}
	});
}

/** Install the tarball from npm as a consumer would and run every check. Returns the failures and non-fatal warnings. */
export async function runPublishPreflight(tarball, parentDirectory = tmpdir()) {
	const consumer = mkdtempSync(join(parentDirectory, "octocode-publish-consumer-"));
	try {
		writeFileSync(
			join(consumer, "package.json"),
			`${JSON.stringify({ private: true, type: "module", dependencies: { [codingAgentName]: `file:${tarball}` } })}\n`,
		);
		execNpmSync(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], {
			cwd: consumer,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const failures = [];
		try {
			smokeTestCodingAgent(consumer, process.execPath, { strictRuntime: true });
		} catch (error) {
			failures.push(`install smoke test: ${error.message}`);
		}
		failures.push(...findNativeHelperProblems(consumer));
		failures.push(...(await runImageWorkerCheck(consumer)));
		failures.push(...(await runSessionCheck(consumer)));
		const warnings = [];
		const bin = join(consumer, "node_modules/.bin/octocode");
		const ours = realpathSync(join(consumer, "node_modules", codingAgentName, "dist/bundle/cli.js"));
		if (!existsSync(bin) || realpathSync(bin) !== ours)
			warnings.push(
				"another installed package owns the `octocode` command in a project install. Global installs work unless the `octocode` package is also installed globally (npm reports EEXIST).",
			);
		return { failures, warnings };
	} finally {
		rmSync(consumer, { force: true, recursive: true });
	}
}
