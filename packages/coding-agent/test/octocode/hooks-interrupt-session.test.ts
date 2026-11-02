import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { getCliInvocation } from "../../src/config.ts";
import { tmp, trustFolder } from "./helpers.ts";
import { createTestSession } from "../helpers/session.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
afterEach(() => vi.unstubAllEnvs());

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Event = Record<string, unknown>;
type HookRecord = { input: Event; providerClosed: boolean };
async function fixture(
	options: {
		response?: "hold" | "success" | "failure";
		delay?: number;
		timeout?: number;
		output?: string;
		subagent?: boolean;
		async?: boolean;
		mcp?: "success" | "hold";
	} = {},
) {
	const root = tmp("interrupt-real-session-"),
		cwd = path.join(root, "project"),
		home = path.join(root, "home"),
		agentDir = path.join(root, "agent"),
		sessionDir = path.join(root, "sessions");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	const providerClosed = path.join(root, "provider-closed"),
		capture = path.join(root, "hook.jsonl");
	const requests: Event[] = [];
	const events: Event[] = [];
	let stderr = "";
	let parseError: Error | undefined;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.on("close", () => fs.writeFileSync(providerClosed, "closed"));
		if (!options.response || options.response === "hold") return;
		if (options.response === "failure") {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						message: "FIXTURE_PROVIDER_FAILURE",
						type: "invalid_request_error",
					},
				}),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "COMPLETE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
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
		}),
	);
	fs.mkdirSync(path.join(home, ".codex"));
	const script = path.join(root, "hook.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:JSON.parse(text),providerClosed:fs.existsSync(${JSON.stringify(providerClosed)})})+'\\n');setTimeout(()=>console.log(${JSON.stringify(options.output ?? "{}")}),${options.delay ?? 0});});`,
	);
	const command = `${quote(process.execPath)} ${quote(script)}`;
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				Interrupt: [
					{
						matcher: "[ignored-invalid-regex",
						hooks: [
							{
								type: "command",
								command,
								...(options.async ? { async: true } : {}),
								...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
							},
						],
					},
				],
				Stop: [{ hooks: [{ type: "command", command }] }],
			},
		}),
	);

	const mcpCapture = path.join(root, "mcp.jsonl");
	if (options.mcp) {
		const serverFile = path.join(root, "mcp.cjs");
		fs.writeFileSync(
			serverFile,
			`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(mcpCapture)},JSON.stringify({message:m,providerClosed:fs.existsSync(${JSON.stringify(providerClosed)}),pid:process.pid})+'\\n');if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'policy',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'observe',inputSchema:{type:'object',properties:{},additionalProperties:true}}]};else if(m.method==='tools/call'){if(${JSON.stringify(options.mcp)}==='hold')return;result={content:[{type:'text',text:JSON.stringify({systemMessage:'MCP_INTERRUPT_NOTICE'})}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
		);
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					policy: {
						command: process.execPath,
						args: [serverFile],
						exposure: "direct",
					},
				},
			}),
		);
		fs.writeFileSync(
			path.join(home, ".codex/hooks.json"),
			JSON.stringify({
				hooks: {
					Interrupt: [
						{
							hooks: [
								{
									type: "mcp_tool",
									server: "policy",
									tool: "observe",
									input: {
										turn: "${turn_id}",
										model: "${model}",
										session: "${session_id}",
										transcript: "${transcript_path}",
										permission: "${permission_mode}",
									},
								},
							],
						},
					],
				},
			}),
		);
	}
	const env = {
		...process.env,
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_MCP: "0",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_PERMISSION: "workspace",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT: options.subagent ? "1" : "0",
	};
	trustFolder(cwd, env);
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
			sessionDir,
			"--session-id",
			"interrupt-session",
			"--no-extensions",
			...(options.mcp ? ["--extension", "builtin:mcp"] : []),
			"--no-skills",
			"--tools",
			"read",
		],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let exited = false;
	const exit = new Promise<void>((resolve) =>
		child.once("close", () => {
			exited = true;
			resolve();
		}),
	);
	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop()!;
		for (const line of lines.filter(Boolean)) {
			try {
				events.push(JSON.parse(line));
			} catch (error) {
				parseError = error as Error;
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const send = (command: Event) => child.stdin.write(JSON.stringify(command) + "\n");
	const wait = async (predicate: () => boolean, timeout = 15000) => {
		const deadline = Date.now() + timeout;
		while (!predicate()) {
			if (exited || parseError || Date.now() > deadline)
				throw new Error(
					`RPC fixture wait failed: exited=${exited} parse=${parseError?.message} stderr=${stderr} events=${JSON.stringify(events)}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const response = (id: string) => events.find((event) => event.type === "response" && event.id === id);
	const records = (): HookRecord[] =>
		fs.existsSync(capture)
			? fs
					.readFileSync(capture, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const close = async () => {
		if (!exited) {
			child.stdin.end();
			await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))]);
			if (!exited) {
				child.kill("SIGKILL");
				await exit;
			}
		}
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return {
		root,
		mcpRecords: () =>
			fs.existsSync(mcpCapture)
				? fs
						.readFileSync(mcpCapture, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(
							(line) =>
								JSON.parse(line) as {
									message: Event;
									providerClosed: boolean;
									pid: number;
								},
						)
				: [],
		cwd,
		agentDir,
		env,
		sessionDir,
		requests,
		events,
		send,
		wait,
		response,
		records,
		close,
		exit,
		child,
	};
}
const interrupts = (f: Awaited<ReturnType<typeof fixture>>) =>
	f.records().filter((record) => record.input.hook_event_name === "Interrupt");

it("runs one observational Interrupt after real RPC provider cancellation, including repeated abort", async () => {
	const f = await fixture();
	try {
		f.send({ type: "prompt", id: "prompt", message: "Wait for cancellation" });
		await f.wait(() => f.requests.length === 1);
		f.send({ type: "abort", id: "abort-one" });
		f.send({ type: "abort", id: "abort-two" });
		await f.wait(() => !!f.response("abort-one") && !!f.response("abort-two"));
		expect(f.response("abort-one")!.success).toBe(true);
		expect(interrupts(f)).toHaveLength(1);
		const record = interrupts(f)[0];
		expect(record.providerClosed).toBe(true);
		expect(record.input.session_id).toBe("interrupt-session");
		expect(record.input.turn_id).toEqual(expect.any(String));
		expect(record.input.turn_id).not.toBe("");
		expect(record.input.model).toBe("fixture");
		expect(record.input.permission_mode).toBe("default");
		expect(record.input.transcript_path).toEqual(expect.any(String));
		expect(fs.existsSync(String(record.input.transcript_path))).toBe(true);
		expect(f.requests).toHaveLength(1);
		expect(f.records().filter((record) => record.input.hook_event_name === "Stop")).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);

it.each(["success", "failure"] as const)(
	"does not classify provider %s as interruption",
	async (response) => {
		const f = await fixture({ response });
		try {
			f.send({ type: "prompt", id: "prompt", message: "Complete normally" });
			await f.wait(() => f.events.some((e) => e.type === "agent_settled"));
			f.send({ type: "abort", id: "idle-abort" });
			await f.wait(() => !!f.response("idle-abort"));
			expect(interrupts(f)).toHaveLength(0);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
	30000,
);

it("does not emit Interrupt for an idle abort before any turn", async () => {
	const f = await fixture();
	try {
		f.send({ type: "abort", id: "idle" });
		await f.wait(() => !!f.response("idle"));
		expect(interrupts(f)).toHaveLength(0);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);

it("does not emit main-session Interrupt in an actual child process", async () => {
	const f = await fixture({ subagent: true });
	try {
		f.send({ type: "prompt", id: "prompt", message: "Child work" });
		await f.wait(() => f.requests.length === 1);
		f.send({ type: "abort", id: "cancel" });
		await f.wait(() => !!f.response("cancel"));
		expect(interrupts(f)).toHaveLength(0);
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30000);

it("does not classify RPC session replacement as user interruption", async () => {
	const f = await fixture();
	try {
		f.send({ type: "prompt", id: "prompt", message: "Replace this session" });
		await f.wait(() => f.requests.length === 1);
		f.send({ type: "new_session", id: "replace" });
		await f.wait(() => !!f.response("replace"));
		expect(f.response("replace")!.success).toBe(true);
		expect(interrupts(f)).toHaveLength(0);
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30000);

it("does not classify RPC shutdown as user interruption", async () => {
	const f = await fixture();
	try {
		f.send({ type: "prompt", id: "prompt", message: "Shutdown this session" });
		await f.wait(() => f.requests.length === 1);
		f.child.stdin.end();
		await Promise.race([
			f.exit,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Shutdown did not finish")), 10000)),
		]);
		expect(interrupts(f)).toHaveLength(0);
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30000);

it.each([
	JSON.stringify({ systemMessage: "INTERRUPT_NOTICE" }),
	JSON.stringify({ decision: "block", reason: "MUST_NOT_CONTINUE" }),
	"not-json",
])(
	"keeps interruption output observational: %s",
	async (output) => {
		const f = await fixture({ output });
		try {
			f.send({
				type: "prompt",
				id: "prompt",
				message: "Interrupt output fixture",
			});
			await f.wait(() => f.requests.length === 1);
			f.send({ type: "abort", id: "cancel" });
			await f.wait(() => !!f.response("cancel"));
			expect(f.response("cancel")!.success).toBe(true);
			if (output.includes("INTERRUPT_NOTICE")) {
				expect(f.events).toContainEqual(
					expect.objectContaining({
						type: "extension_ui_request",
						method: "notify",
						message: "INTERRUPT_NOTICE",
						notifyType: "warning",
					}),
				);
			}
			expect(interrupts(f)).toHaveLength(1);
			expect(f.requests).toHaveLength(1);
			expect(f.records().filter((r) => r.input.hook_event_name === "Stop")).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	30000,
);

it.each([undefined, 30])(
	"bounds slow Interrupt hooks with configured timeout %s",
	async (timeout) => {
		const f = await fixture({ timeout, delay: 10000 });
		try {
			f.send({
				type: "prompt",
				id: "prompt",
				message: "Bound cancellation cleanup",
			});
			await f.wait(() => f.requests.length === 1);
			const started = Date.now();
			f.send({ type: "abort", id: "cancel" });
			await f.wait(() => !!f.response("cancel"), 6000);
			expect(interrupts(f)).toHaveLength(1);
			expect(Date.now() - started).toBeLessThan(timeout === undefined ? 2500 : 4500);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
	30000,
);

it("captures the current permission and persisted turn through direct AgentSession.abort", async () => {
	const f = await fixture();
	for (const [key, value] of Object.entries(f.env)) if (value !== undefined) vi.stubEnv(key, value);
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: f.cwd,
		agentDir: f.agentDir,
		settingsManager,
		disabledFeatures: ["mcp", "llama.cpp"],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd: f.cwd,
		agentDir: f.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(f.cwd, f.sessionDir),
		tools: ["read"],
	});
	try {
		await session.bindExtensions({
			mode: "json",
			shutdownHandler: () => undefined,
		} as never);
		await session.setModel(session.modelRuntime.getModel("fixture-local", "fixture")!);
		await session.prompt("/permissions full");
		const running = session.prompt("DIRECT_SESSION_INTERRUPT");
		await f.wait(() => f.requests.length === 1);
		const id = session.getTurnId();
		await session.abort();
		await running;
		expect(interrupts(f)).toHaveLength(1);
		const input = interrupts(f)[0].input;
		expect(input.permission_mode).toBe("bypassPermissions");
		expect(input.turn_id).toBe(id);
		expect(input.session_id).toBe(session.sessionId);
		expect(input.transcript_path).toBe(session.sessionFile);
		expect(fs.readFileSync(String(input.transcript_path), "utf8")).toContain("DIRECT_SESSION_INTERRUPT");
		expect(f.requests).toHaveLength(1);
	} finally {
		await session.abort("shutdown");
		session.dispose();
		await f.close();
	}
}, 30000);

it("runs an asynchronous Interrupt command without continuing the canceled provider", async () => {
	const f = await fixture({ async: true });
	try {
		f.send({ type: "prompt", id: "prompt", message: "Async interruption" });
		await f.wait(() => f.requests.length === 1);
		f.send({ type: "abort", id: "cancel" });
		await f.wait(() => !!f.response("cancel") && interrupts(f).length === 1);
		expect(f.response("cancel")!.success).toBe(true);
		expect(f.requests).toHaveLength(1);
		expect(interrupts(f)[0].providerClosed).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

it.each(["success", "hold"] as const)(
	"runs Interrupt through a real configured MCP transport: %s",
	async (mcp) => {
		const f = await fixture({ mcp });
		try {
			f.send({
				type: "prompt",
				id: "prompt",
				message: "MCP interruption fixture",
			});
			// The policy server is used only by the hook: no tool selection names it (`--tools read`), so the hook's call
			// starts it.
			await f.wait(() => f.requests.length === 1);
			expect(f.mcpRecords().some((r) => r.message.method === "tools/list")).toBe(false);
			const started = Date.now();
			f.send({ type: "abort", id: "cancel" });
			await f.wait(() => !!f.response("cancel"), 6000);
			expect(f.response("cancel")!.success).toBe(true);
			const calls = f.mcpRecords().filter((r) => r.message.method === "tools/call");
			expect(calls).toHaveLength(1);
			expect(calls[0].providerClosed).toBe(true);
			const params = calls[0].message.params as {
				name: string;
				arguments: Record<string, unknown>;
			};
			expect(params.name).toBe("observe");
			expect(params.arguments).toMatchObject({
				model: "fixture",
				session: "interrupt-session",
				permission: "default",
				turn: expect.any(String),
				transcript: expect.any(String),
			});
			expect(fs.readFileSync(String(params.arguments.transcript), "utf8")).toContain("MCP interruption fixture");
			expect(f.requests).toHaveLength(1);
			if (mcp === "success")
				expect(f.events).toContainEqual(
					expect.objectContaining({
						type: "extension_ui_request",
						method: "notify",
						message: "MCP_INTERRUPT_NOTICE",
					}),
				);
			else {
				expect(Date.now() - started).toBeLessThan(2500);
				await f.wait(() => f.mcpRecords().some((r) => r.message.method === "notifications/cancelled"));
			}
		} finally {
			await f.close();
		}
		const pid = f.mcpRecords()[0].pid;
		expect(() => process.kill(pid, 0)).toThrow();
	},
	30000,
);
