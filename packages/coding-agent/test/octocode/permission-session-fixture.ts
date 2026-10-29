import fs from "node:fs";
import path from "node:path";
import { createFauxCore, type JsonObject, fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { vi } from "vitest";
import { Type } from "typebox";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { isNativeTool } from "../../src/octocode/permission/native-tools.ts";
import { saveDecision } from "../../src/octocode/shared/trust.ts";
import { createReadTool } from "../fixtures/read-tool.ts";
import { createWriteTool } from "../fixtures/write-tool.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { tmp } from "./helpers.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
type Options = {
	rules?: { deny?: string[]; ask?: string[]; allow?: string[] };
	hooksEnabled?: boolean;
	customClaudeHome?: boolean;
	projectRules?: { deny?: string[]; ask?: string[]; allow?: string[] };
	projectTrusted?: boolean;
	readTool?: boolean;
	fileReadTool?: boolean;
	fileWriteTool?: boolean;
	nestedMcp?: boolean;
	nestedBash?: boolean;
	output?: unknown;
	exit?: number;
	stderr?: string;
	mode?: "manual" | "full";
	matcher?: string;
	hold?: boolean;
	secondOutput?: unknown;
	preDeny?: boolean;
	conditionalPath?: boolean;
};
export async function fixture(protocol: "claude" | "codex", options: Options = {}) {
	const root = tmp("permission-hook-session-"),
		cwd = path.join(root, "project"),
		home = path.join(root, "home"),
		agentDir = path.join(root, "agent");
	for (const d of [cwd, home, agentDir]) fs.mkdirSync(d);
	for (const [key, value] of Object.entries({
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_PERMISSION: options.mode ?? "manual",
		OCTOCODE_MCP: "0",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_SUBAGENT: "0",
		OCTOCODE_MODELS_DEV: "0",
	}))
		vi.stubEnv(key, value);
	const capture = path.join(root, "capture.jsonl"),
		marker = path.join(cwd, "effect.txt"),
		script = path.join(root, "hook.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(root, "hook.pid"))},String(process.pid));let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(capture)},s+'\\n');if(${options.hold === true}){while(!fs.existsSync(${JSON.stringify(path.join(root, "release"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}console.log(JSON.stringify(${options.conditionalPath ? "(JSON.parse(s).tool_input.file_path.endsWith('permitted.txt') ? {hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}} : {})" : JSON.stringify(options.output ?? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })}));process.stderr.write(${JSON.stringify(options.stderr ?? "")});process.exitCode=${options.exit ?? 0};});`,
	);
	const configDir = options.customClaudeHome ? path.join(root, "custom-claude") : path.join(home, `.${protocol}`);
	if (options.customClaudeHome) vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, protocol === "claude" ? "settings.json" : "hooks.json"),
		JSON.stringify({
			permissions: options.rules,
			hooks:
				options.hooksEnabled === false
					? {}
					: {
							...(options.preDeny
								? {
										PreToolUse: [
											{
												hooks: [
													{
														type: "command",
														command: `${quote(process.execPath)} -e ${quote("console.log(" + JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PRE_GATE_DENIAL" } })) + ")")}`,
													},
												],
											},
										],
									}
								: {}),
							PermissionRequest: [
								{
									matcher: options.matcher ?? "",
									hooks: [
										{
											type: "command",
											command: `${quote(process.execPath)} ${quote(script)}`,
										},
										...(options.secondOutput === undefined
											? []
											: [
													{
														type: "command",
														command: `${quote(process.execPath)} -e ${quote("console.log(" + JSON.stringify(JSON.stringify(options.secondOutput)) + ")")}`,
													},
												]),
									],
								},
							],
						},
		}),
	);
	if (options.projectRules) {
		fs.mkdirSync(path.join(cwd, ".claude"));
		fs.writeFileSync(path.join(cwd, ".claude/settings.json"), JSON.stringify({ permissions: options.projectRules }));
	}
	if (options.projectRules && options.projectTrusted !== undefined)
		saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), options.projectTrusted);
	const mcpCapture = path.join(root, "mcp.jsonl");
	if (options.nestedMcp) {
		const serverFile = path.join(root, "mcp.cjs");
		fs.writeFileSync(
			serverFile,
			`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(mcpCapture)},JSON.stringify({message:m,pid:process.pid})+'\\n');if(m.id===undefined)return;let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'policy',version:'1'}}:m.method==='tools/list'?{tools:[{name:'observe',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}:m.method==='tools/call'?{content:[{type:'text',text:'NESTED_MCP_READ_EVIDENCE'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
		);
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					policy: {
						command: process.execPath,
						args: [serverFile],
					},
				},
			}),
		);
	}
	let providerRequests = 0;
	const faux = createFauxCore({
		provider: "permission-fixture",
		models: [{ id: "fixture", contextWindow: 200000, maxTokens: 4096 }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
	});
	if (options.projectTrusted !== undefined) settingsManager.setProjectTrusted(options.projectTrusted);
	const makeResourceLoader = () =>
		new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			...(options.nestedMcp ? { additionalExtensionPaths: ["builtin:mcp"] } : {}),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: "permission-fixture",
					factory(api) {
						if (options.nestedMcp)
							api.registerTool({
								name: "nested_mcp_policy_fixture",
								label: "Nested MCP fixture",
								description: "Read through the configured fixture MCP server",
								parameters: Type.Object({}),
								async execute(_id, _args, _signal, _update, ctx) {
									const outcome = await ctx.executeTool("mcp__policy__observe", {});
									return {
										content: [{ type: "text", text: JSON.stringify(outcome) }],
										details: {},
									};
								},
							});
						api.registerTool({
							name: "nested_permission_fixture",
							label: "Nested permission fixture",
							description: "Run two safe fixture file writes",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, _update, ctx) {
								const outcomes = await Promise.all(
									["nested-a.txt", "nested-b.txt"].map((name) =>
										ctx.executeTool("file", {
											queries: [
												{
													type: "write",
													path: path.join(cwd, name),
													content: name + "\n",
													reason: "Nested acceptance fixture",
												},
											],
										}),
									),
								);
								return {
									content: [{ type: "text", text: JSON.stringify(outcomes) }],
									details: {},
								};
							},
						});
						if (options.nestedBash)
							api.registerTool({
								name: "nested_bash_rewrite_fixture",
								label: "Nested Bash fixture",
								description: "Run two owned acceptance commands",
								parameters: Type.Object({}),
								async execute(_id, _args, _signal, _update, ctx) {
									const outcomes = await Promise.all(
										["a", "b"].map((name) =>
											ctx.executeTool("bash", {
												reason: "Run the owned acceptance command",
												command: `printf ORIGINAL_${name} > original-${name}.txt`,
											}),
										),
									);
									return {
										content: [{ type: "text", text: JSON.stringify(outcomes) }],
										details: {},
									};
								},
							});
						api.registerProvider("permission-fixture", {
							name: "Fixture",
							api: faux.api,
							baseUrl: "http://127.0.0.1:0",
							apiKey: "test",
							models: faux.models,
							streamSimple: faux.streamSimple,
						} as never);
					},
				},
			],
		});
	let resourceLoader = makeResourceLoader();
	await resourceLoader.reload();
	const makeSession = async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			...(options.readTool
				? { tools: ["read"], customTools: [createReadTool(cwd)] }
				: options.fileWriteTool
					? { customTools: [createWriteTool(cwd)] }
					: options.fileReadTool
						? { customTools: [createReadTool(cwd)] }
						: {}),
			sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
		});
		await session.bindExtensions({
			mode: "json",
			shutdownHandler: () => undefined,
		} as never);
		await session.setModel(session.modelRuntime.getModel("permission-fixture", "fixture")!);
		return session;
	};
	let session = await makeSession();
	return {
		get providerRequests() {
			return providerRequests;
		},
		get session() {
			return session;
		},
		async restart() {
			await session.abort("shutdown");
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
			resourceLoader = makeResourceLoader();
			await resourceLoader.reload();
			session = await makeSession();
		},
		marker,
		capture,
		cwd,
		root,
		configDir,
		mcpRecords() {
			return fs.existsSync(mcpCapture)
				? fs
						.readFileSync(mcpCapture, "utf8")
						.trim()
						.split("\n")
						.map((s) => JSON.parse(s))
				: [];
		},
		inputs() {
			return fs.existsSync(capture)
				? fs
						.readFileSync(capture, "utf8")
						.trim()
						.split("\n")
						.map((s) => JSON.parse(s))
				: [];
		},
		async run(
			tool = "bash",
			args: JsonObject = {
				command: `printf PERMISSION_EFFECT > ${quote(marker)}`,
			},
		) {
			faux.setResponses([
				() => {
					providerRequests++;
					// Native tools require a `reason`; a fixture that names none states the fixture's own.
					const called =
						isNativeTool(tool) && args.reason === undefined ? { ...args, reason: "Permission fixture" } : args;
					return fauxAssistantMessage([fauxToolCall(tool, called)], {
						stopReason: "toolUse",
					});
				},
				() => {
					providerRequests++;
					return fauxAssistantMessage("DONE");
				},
			]);
			await session.prompt("Run the permission fixture.");
		},
		async close() {
			await session.abort("shutdown");
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
		},
	};
}
