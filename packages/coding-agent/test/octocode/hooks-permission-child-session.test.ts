import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp, trustFolder } from "./helpers.ts";
import { buildAgentArgs, childSessionFile } from "../../src/octocode/subagents/process/session.ts";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
afterEach(() => vi.unstubAllEnvs());
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const allowed = {
	hookSpecificOutput: {
		hookEventName: "PermissionRequest",
		decision: { behavior: "allow" },
	},
};
async function fixture(
	protocol: "claude" | "codex",
	transport: "command" | "http" | "mcp" | "prompt" = "command",
	options: {
		rules?: { deny?: string[]; ask?: string[] };
		hooksEnabled?: boolean;
		mode?: "manual" | "full";
		grantShell?: boolean;
	} = {},
) {
	const root = tmp("permission-child-"),
		cwd = path.join(root, "project"),
		home = path.join(root, "home"),
		agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	const effect = path.join(cwd, "child-effect.txt");
	const capture = path.join(root, "hooks.jsonl"),
		mcpCapture = path.join(root, "mcp.jsonl"),
		requests: Array<Record<string, unknown>> = [],
		httpInputs: Array<Record<string, unknown>> = [];
	let promptRequests = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (req.url === "/policy") {
			httpInputs.push(body);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(allowed));
			return;
		}
		const isPrompt = JSON.stringify(body.messages).includes("Evaluate the supplied hook rule");
		if (isPrompt) promptRequests++;
		else requests.push(body);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const choice = isPrompt
			? {
					delta: {
						role: "assistant",
						content: JSON.stringify({
							ok: false,
							reason: "OBSERVATIONAL_PROMPT_FALSE",
						}),
					},
					finish_reason: "stop",
				}
			: requests.length === 1
				? {
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "permission-child-call",
									type: "function",
									function: {
										name: "bash",
										arguments: JSON.stringify({
											reason: "Run the child permission fixture",
											command: options.rules
												? `printf EXECUTED > ${quote(effect)}; printf CHILD_PERMISSION_ALLOWED`
												: "printf CHILD_PERMISSION_ALLOWED",
										}),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					}
				: {
						delta: { role: "assistant", content: "CHILD_DONE" },
						finish_reason: "stop",
					};
		res.end(
			`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl: origin + "/v1",
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
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_MCP: "0",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_PERMISSION: "manual",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT_LINGER_SECONDS: "0",
	}))
		vi.stubEnv(key, value);
	trustFolder(cwd);
	const script = path.join(root, "hook.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(capture)},s+'\\n');console.log(${JSON.stringify(JSON.stringify(allowed))});});`,
	);
	const hooks: Array<Record<string, unknown>> =
		transport === "http"
			? [{ type: "http", url: origin + "/policy" }]
			: transport === "mcp"
				? [
						{
							type: "mcp_tool",
							server: "policy",
							tool: "decide",
							input: {
								session: "${session_id}",
								turn: "${turn_id}",
								agent: "${agent_id}",
								tool: "${tool_name}",
								command: "${tool_input.command}",
							},
						},
					]
				: [
						{
							type: "command",
							command: `${quote(process.execPath)} ${quote(script)}`,
						},
						...(transport === "prompt"
							? [
									{
										type: "prompt",
										prompt: "Observe the request and return false. $ARGUMENTS",
										model: "fixture-local/fixture",
									},
								]
							: []),
					];
	const configDir = path.join(home, `.${protocol}`);
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, protocol === "claude" ? "settings.json" : "hooks.json"),
		JSON.stringify({
			permissions: options.rules,
			hooks: { PermissionRequest: [{ hooks }] },
		}),
	);
	if (transport === "mcp") {
		const mcpScript = path.join(root, "mcp.cjs");
		fs.writeFileSync(
			mcpScript,
			`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(mcpCapture)},JSON.stringify({message:m,pid:process.pid})+'\\n');if(m.id===undefined)return;let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'policy',version:'1'}}:m.method==='tools/list'?{tools:[{name:'decide',inputSchema:{type:'object',additionalProperties:true}}]}:m.method==='tools/call'?{content:[{type:'text',text:${JSON.stringify(JSON.stringify(allowed))}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
		);
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					policy: {
						command: process.execPath,
						args: [mcpScript],
						exposure: "direct",
					},
				},
			}),
		);
	}
	const parent = SessionManager.create(cwd, path.join(root, "parent"));
	parent.appendMessage({
		role: "user",
		content: [{ type: "text", text: "PARENT_CONTEXT" }],
		timestamp: Date.now(),
	});
	const childSession = {
		dir: path.join(root, "child"),
		id: "permission-child-session",
	};
	const identity: Identity = {
		id: "permission-worker",
		role: "reviewer",
		parentId: "parent-worker",
		parentSession: parent.getSessionId(),
		parentTranscript: parent.getSessionFile(),
		scratch: path.join(root, "scratch"),
		permission: {
			mode: options.mode ?? "manual",
			grants: options.grantShell ? ["shell"] : [],
		},
	};
	const profile = {
		name: "reviewer",
		description: "Permission fixture",
		prompt: "Run the requested safe command.",
		tools: "bash",
		...(options.hooksEnabled === false ? {} : { hooks: true as const }),
	};
	const read = (file: string) =>
		fs.existsSync(file)
			? fs
					.readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((s) => JSON.parse(s))
			: [];
	return {
		effect,
		requests,
		httpInputs,
		childSession,
		identity,
		get promptRequests() {
			return promptRequests;
		},
		records: () => read(capture),
		mcpRecords: () => read(mcpCapture),
		async run() {
			const args = buildAgentArgs(profile, "fixture-local/fixture", childSession, []);
			if (transport === "mcp") args.push("--extension", "builtin:mcp");
			return runSubagent("Run fixture command", args, cwd, profile, identity, undefined, () => undefined);
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
it.each(["claude", "codex"] as const)(
	"%s child source hook resolves manual permission before unavailable parent relay",
	async (protocol) => {
		const f = await fixture(protocol);
		try {
			const result = await f.run();
			expect(result.error).toBeUndefined();
			expect(f.requests).toHaveLength(2);
			expect(JSON.stringify(f.requests[1])).toContain("CHILD_PERMISSION_ALLOWED");
			const records = f.records();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				hook_event_name: "PermissionRequest",
				session_id: f.childSession.id,
				agent_id: protocol === "codex" ? f.childSession.id : f.identity.id,
				agent_type: "reviewer",
				permission_mode: "default",
				transcript_path: childSessionFile(f.childSession),
			});
		} finally {
			await f.close();
		}
	},
	60000,
);
it("Claude HTTP permission handler resolves a real child tool request", async () => {
	const f = await fixture("claude", "http");
	try {
		const result = await f.run();
		expect(result.error).toBeUndefined();
		expect(JSON.stringify(f.requests[1])).toContain("CHILD_PERMISSION_ALLOWED");
		expect(f.httpInputs).toHaveLength(1);
		expect(f.httpInputs[0]).toMatchObject({
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			session_id: f.childSession.id,
		});
	} finally {
		await f.close();
	}
}, 60000);
it("Codex configured MCP permission handler resolves through an actual stdio transport", async () => {
	const f = await fixture("codex", "mcp");
	try {
		const result = await f.run();
		expect(result.error).toBeUndefined();
		expect(JSON.stringify(f.requests[1])).toContain("CHILD_PERMISSION_ALLOWED");
		const records = f.mcpRecords();
		const calls = records.filter((x) => x.message.method === "tools/call");
		expect(calls).toHaveLength(1);
		expect(calls[0].message.params.arguments).toMatchObject({
			session: f.childSession.id,
			agent: f.childSession.id,
			tool: "Bash",
		});
		expect(calls[0].message.params.arguments.turn).toEqual(expect.any(String));
		expect(() => process.kill(calls[0].pid, 0)).toThrow();
	} finally {
		await f.close();
	}
}, 60000);
it("Claude prompt ok false remains observational beside an actual command permission allowance", async () => {
	const f = await fixture("claude", "prompt");
	try {
		const result = await f.run();
		expect(result.error).toBeUndefined();
		expect(f.promptRequests).toBe(1);
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests[1])).toContain("CHILD_PERMISSION_ALLOWED");
		expect(f.records()).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 60000);

it.each([
	{
		name: "deny before full",
		rules: { deny: ["Bash"] },
		mode: "full" as const,
	},
	{ name: "ask before full", rules: { ask: ["Bash"] }, mode: "full" as const },
	{
		name: "ask before inherited grant",
		rules: { ask: ["Bash"] },
		mode: "manual" as const,
		grantShell: true,
	},
])(
	"Claude child source $name stays enforced while child hooks are disabled",
	async (options) => {
		const f = await fixture("claude", "command", {
			...options,
			hooksEnabled: false,
		});
		try {
			const result = await f.run();
			expect(result.error).toBeUndefined();
			expect(f.requests).toHaveLength(2);
			expect(JSON.stringify(f.requests[1])).not.toContain('"content":"CHILD_PERMISSION_ALLOWED');
			expect(f.records()).toEqual([]);
			const messages = f.requests[1].messages as Array<{
				role: string;
				content: unknown;
			}>;
			const toolMessages = messages.filter((message) => message.role === "tool");
			expect(toolMessages).toHaveLength(1);
			expect(fs.existsSync(f.effect)).toBe(false);
			expect(JSON.stringify(toolMessages)).toMatch(/Not run|denied|not found|disabled/i);
		} finally {
			await f.close();
		}
	},
	60000,
);
