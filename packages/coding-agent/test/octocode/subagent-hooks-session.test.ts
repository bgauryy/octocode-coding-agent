import fs from "node:fs";
import { spawn } from "node:child_process";
import { getCliInvocation } from "../../src/config.ts";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { buildAgentArgs, childSessionFile, runSubagent, type Identity } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Wire = {
	hook_event_name: string;
	session_id?: string;
	agent_id?: string;
	agent_type?: string;
	transcript_path?: string;
	agent_transcript_path?: string;
	turn_id?: string;
	permission_mode?: string;
	[key: string]: unknown;
};
async function fixture(
	protocol: "codex" | "claude",
	options: {
		hooks?: boolean;
		blockStop?: boolean;
		holdProvider?: boolean;
		providerError?: boolean;
		ordinary?: boolean;
	} = {},
) {
	const root = tmp("real-child-hooks-");
	const cwd = path.join(root, "project"),
		home = path.join(root, "home"),
		agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	const requests: Array<Record<string, unknown>> = [];
	let providerStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		providerStarted = resolve;
	});
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		providerStarted();
		if (options.holdProvider) return;
		if (options.providerError) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						message: "FIXTURE_PROVIDER_FAILURE",
						type: "invalid_request_error",
						code: "invalid_request",
					},
				}),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });

		if (options.ordinary && requests.length % 2 === 1) {
			res.end(
				`data: ${JSON.stringify({ id: `tool-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf CHILD_TOOL_OUTPUT" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		const content = requests.length === 1 ? "CHILD_FIRST_RESPONSE" : "CHILD_RETRIED_RESPONSE";
		res.end(
			`data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "fixture",
							name: "Fixture",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	for (const [key, value] of Object.entries({
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_MCP: "0",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_HOOKS: "1",
		OCTOCODE_HOOKS_COMPAT: "1",
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT_LINGER_SECONDS: "0",
		CODEX_HOME: path.join(home, ".codex"),
	}))
		vi.stubEnv(key, value);
	fs.mkdirSync(path.join(home, ".codex"));
	fs.mkdirSync(path.join(home, ".claude"));
	const captured = path.join(root, "hooks.jsonl"),
		script = path.join(root, "hook.cjs"),
		stopMarker = path.join(root, "stopped-once");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const input=JSON.parse(data);fs.appendFileSync(${JSON.stringify(captured)},data.trim()+'\\n');let out={};if(input.hook_event_name==='SubagentStart')out={hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'CHILD_START_CONTEXT'}};if(input.hook_event_name==='SubagentStop'&&${options.blockStop !== false}&&!fs.existsSync(${JSON.stringify(stopMarker)})){fs.writeFileSync(${JSON.stringify(stopMarker)},'1');out={decision:'block',reason:'CHILD_STOP_RETRY'};}console.log(JSON.stringify(out));});`,
	);
	const command = `${quote(process.execPath)} ${quote(script)}`;
	fs.writeFileSync(
		path.join(home, protocol === "codex" ? ".codex/hooks.json" : ".claude/settings.json"),
		JSON.stringify({
			hooks: Object.fromEntries(
				[
					"SubagentStart",
					"SubagentStop",
					"SessionStart",
					"Stop",
					...(options.ordinary ? ["UserPromptSubmit", "PreToolUse", "PostToolUse"] : []),
				].map((event) => [
					event,
					[
						{
							...(event.startsWith("Subagent") ? { matcher: "^reviewer$" } : {}),
							hooks: [{ type: "command", command }],
						},
					],
				]),
			),
		}),
	);

	const nativeCapture = path.join(root, "native-hooks.jsonl");
	if (options.ordinary) {
		fs.mkdirSync(path.join(home, ".octocode"), { recursive: true });
		const nativeScript = path.join(root, "native-hook.cjs");
		fs.writeFileSync(
			nativeScript,
			`const fs=require('node:fs');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(nativeCapture)},data.trim()+'\\n');console.log('{}');});`,
		);
		fs.writeFileSync(
			path.join(home, ".octocode/hooks.json"),
			JSON.stringify({
				hooks: Object.fromEntries(
					["PreToolUse", "PostToolUse"].map((event) => [
						event,
						[
							{
								hooks: [
									{
										type: "command",
										command: quote(process.execPath) + " " + quote(nativeScript),
									},
								],
							},
						],
					]),
				),
			}),
		);
	}
	const parent = SessionManager.create(cwd, path.join(root, "parent-session"));
	parent.appendMessage({
		role: "user",
		content: [{ type: "text", text: "PARENT_ONLY_CONTEXT" }],
		timestamp: Date.now(),
	});
	const childSession = {
		dir: path.join(root, "child-session"),
		id: "child-session-identity",
	};
	const identity: Identity = {
		id: "worker-display-name",
		role: "reviewer",
		parentId: "parent-worker-name",
		parentSession: parent.getSessionId(),
		parentTranscript: parent.getSessionFile(),
		scratch: path.join(root, "scratch"),
		permission: { mode: "workspace", grants: [] },
	};
	const profile = {
		name: "reviewer",
		description: "Fixture reviewer",
		prompt: "Respond briefly.",
		tools: options.ordinary ? "bash" : "read",
		...(options.hooks !== false ? { hooks: true as const } : {}),
	};
	const run = (signal?: AbortSignal) =>
		runSubagent(
			"Perform fixture review",
			buildAgentArgs(profile, "fixture-local/fixture", childSession, []),
			cwd,
			profile,
			identity,
			signal,
			() => undefined,
		);
	return {
		root,
		nativeRecords: (): Wire[] =>
			fs.existsSync(nativeCapture)
				? fs
						.readFileSync(nativeCapture, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
		requests,
		started,
		parent,
		childSession,
		identity,
		run,
		records: (): Wire[] =>
			fs.existsSync(captured)
				? fs
						.readFileSync(captured, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

it.each(["codex", "claude"] as const)(
	"routes %s lifecycle hooks through the real child session and continuation",
	async (protocol) => {
		const f = await fixture(protocol);
		try {
			const result = await f.run();
			expect(result.error, JSON.stringify(result)).toBeUndefined();
			expect(f.requests.length, JSON.stringify(result)).toBe(2);
			expect(JSON.stringify(f.requests[0])).toContain("CHILD_START_CONTEXT");
			expect(JSON.stringify(f.requests[0])).not.toContain("PARENT_ONLY_CONTEXT");
			expect(JSON.stringify(f.requests[1])).toContain("CHILD_STOP_RETRY");
			expect(result.text).toContain("CHILD_RETRIED_RESPONSE");
			expect(fs.readFileSync(f.parent.getSessionFile()!, "utf8")).not.toMatch(
				/CHILD_START_CONTEXT|CHILD_STOP_RETRY|CHILD_RETRIED_RESPONSE/,
			);
			const records = f.records();
			const start = records.filter((x) => x.hook_event_name === "SubagentStart");
			const stop = records.filter((x) => x.hook_event_name === "SubagentStop");
			expect(start).toHaveLength(1);
			expect(stop).toHaveLength(2);
			expect(start[0]!.agent_type).toBe("reviewer");
			expect(start[0]!.permission_mode).toBe("default");
			expect(records.filter((record) => ["SessionStart", "Stop"].includes(record.hook_event_name))).toHaveLength(0);
			const childFile = childSessionFile(f.childSession);
			expect(childFile).toBeDefined();
			if (protocol === "codex") {
				expect(start[0]!.agent_id).toBe(f.childSession.id);
				expect(start[0]!.agent_id).not.toBe(f.identity.id);
			} else {
				expect(start[0]!.agent_id).toBe(f.identity.id);
				expect(start[0]!.session_id).toBe(f.parent.getSessionId());
			}
			expect(stop[0]!.agent_transcript_path).toBe(childFile);
			expect(stop[0]!.transcript_path).toBe(f.parent.getSessionFile());
			expect(stop[0]!.agent_transcript_path).not.toBe(stop[0]!.transcript_path);
		} finally {
			await f.close();
		}
	},
	60_000,
);

it.each(["codex", "claude"] as const)(
	"preserves child hook opt-in for %s",
	async (protocol) => {
		const f = await fixture(protocol, { hooks: false });
		try {
			const result = await f.run();
			expect(result.error).toBeUndefined();
			expect(f.requests).toHaveLength(1);
			expect(f.records()).toEqual([]);
			expect(JSON.stringify(f.requests)).not.toContain("CHILD_START_CONTEXT");
			expect(JSON.stringify(f.requests)).not.toContain("CHILD_STOP_RETRY");
		} finally {
			await f.close();
		}
	},
	60_000,
);

it.each(["codex", "claude"] as const)(
	"uses source-specific %s startup cadence when the real child session resumes",
	async (protocol) => {
		const f = await fixture(protocol, { blockStop: false });
		try {
			const first = await f.run();
			expect(first.error).toBeUndefined();
			const originalFile = childSessionFile(f.childSession);
			expect(originalFile).toBeDefined();
			const second = await f.run();
			expect(second.error).toBeUndefined();
			expect(childSessionFile(f.childSession)).toBe(originalFile);
			expect(f.requests).toHaveLength(2);
			const starts = f.records().filter((record) => record.hook_event_name === "SubagentStart");
			expect(starts).toHaveLength(protocol === "codex" ? 1 : 2);
			expect(f.records().filter((record) => record.hook_event_name === "SubagentStop")).toHaveLength(2);
			expect(f.records().filter((record) => ["SessionStart", "Stop"].includes(record.hook_event_name))).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	60_000,
);

it.each(["codex", "claude"] as const)(
	"omits %s child stop hooks when the actual provider request is cancelled",
	async (protocol) => {
		const f = await fixture(protocol, { holdProvider: true });
		const controller = new AbortController();
		let running: ReturnType<typeof f.run> | undefined;
		try {
			running = f.run(controller.signal);
			await Promise.race([
				f.started,
				running.then((result) => {
					throw new Error(`Child settled before provider request: ${JSON.stringify(result)}`);
				}),
			]);
			controller.abort();
			await expect(running).rejects.toThrow(/cancel/i);
			expect(f.requests).toHaveLength(1);
			expect(f.records().filter((record) => record.hook_event_name === "SubagentStart")).toHaveLength(1);
			expect(f.records().filter((record) => record.hook_event_name === "SubagentStop")).toHaveLength(0);
		} finally {
			controller.abort();
			await running?.catch(() => undefined);
			await f.close();
		}
	},
	60_000,
);

it.each(["codex", "claude"] as const)(
	"omits %s child stop hooks after a real provider failure",
	async (protocol) => {
		const f = await fixture(protocol, { providerError: true });
		try {
			const result = await f.run();
			expect(result.error).toContain("FIXTURE_PROVIDER_FAILURE");
			expect(f.requests).toHaveLength(1);
			expect(f.records().filter((record) => record.hook_event_name === "SubagentStart")).toHaveLength(1);
			expect(f.records().filter((record) => record.hook_event_name === "SubagentStop")).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	60_000,
);

it.each(["codex", "claude"] as const)(
	"carries %s ordinary child identity through real tool execution and resume",
	async (protocol) => {
		const f = await fixture(protocol, { ordinary: true, blockStop: false });
		try {
			for (let turn = 1; turn <= 2; turn++) {
				const result = await f.run();
				expect(result.error, JSON.stringify(result)).toBeUndefined();
				expect(f.requests).toHaveLength(turn * 2);
				const records = f.records(),
					childFile = childSessionFile(f.childSession);
				for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
					const matches = records.filter((r) => r.hook_event_name === event);
					expect(matches, event).toHaveLength(turn);
					const input = matches.at(-1)!;
					expect(input.agent_id, event).toBe(protocol === "codex" ? f.childSession.id : f.identity.id);
					expect(input.agent_type, event).toBe("reviewer");
					expect(input.session_id, event).toBe(f.childSession.id);
					expect(input.transcript_path, event).toBe(childFile);
				}
				const starts = records.filter((r) => r.hook_event_name === "SubagentStart");
				expect(starts).toHaveLength(protocol === "codex" ? 1 : turn);
				expect(starts[0]!.agent_id).toBe(protocol === "codex" ? f.childSession.id : f.identity.id);
				const stops = records.filter((r) => r.hook_event_name === "SubagentStop");
				expect(stops).toHaveLength(turn);
				if (protocol === "claude") {
					expect(stops.at(-1)!.transcript_path).toBe(f.parent.getSessionFile());
					expect(stops.at(-1)!.agent_transcript_path).toBe(childFile);
				}
				expect(JSON.stringify(f.requests.at(-1))).toContain("CHILD_TOOL_OUTPUT");
			}
		} finally {
			await f.close();
		}
	},
	30000,
);

it.each(["codex", "claude"] as const)(
	"omits %s ordinary optional identity in a real main process with stale inherited agent variables",
	async (protocol) => {
		const f = await fixture(protocol, { ordinary: true, blockStop: false });
		const launch = getCliInvocation();
		const child = spawn(
			launch.command,
			[
				...launch.prefix,
				"--mode",
				"rpc",
				"--model",
				"fixture-local/fixture",
				"--session-dir",
				path.join(f.root, "main-session"),
				"--session-id",
				"main-session-identity",
				"--no-extensions",
				"--no-skills",
				"--tools",
				"bash",
			],
			{
				cwd: path.join(f.root, "project"),
				env: {
					...process.env,
					OCTOCODE_SUBAGENT: "0",
					OCTOCODE_AGENT_ID: "stale-inherited-worker",
					OCTOCODE_AGENT_ROLE: "stale-inherited-role",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "",
			pending = "",
			settled = false;
		const events: Record<string, unknown>[] = [];
		let exited = false;
		const exit = new Promise<void>((resolve) =>
			child.once("close", () => {
				exited = true;
				resolve();
			}),
		);
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines.filter(Boolean)) {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "agent_settled") settled = true;
			}
		});
		try {
			child.stdin.write(
				JSON.stringify({
					type: "prompt",
					id: "prompt",
					message: "Main ordinary identity fixture",
				}) + "\n",
			);
			const deadline = Date.now() + 15000;
			while (!settled) {
				if (exited || Date.now() > deadline) throw new Error(`Main fixture failed ${stderr} ${JSON.stringify(events)}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(f.requests).toHaveLength(2);
			for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
				const records = f.records().filter((r) => r.hook_event_name === event);
				expect(records, event).toHaveLength(1);
				expect(records[0]).not.toHaveProperty("agent_id");
				expect(records[0]).not.toHaveProperty("agent_type");
				expect(records[0]!.session_id).toBe("main-session-identity");
			}
			expect(JSON.stringify(f.requests.at(-1))).toContain("CHILD_TOOL_OUTPUT");
		} finally {
			child.stdin.end();
			await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))]);
			if (!exited) {
				child.kill("SIGKILL");
				await exit;
			}
			await f.close();
		}
	},
	30000,
);
