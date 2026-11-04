import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acpClient, initialize } from "./e2e-acp-client.ts";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	pidFrom,
	alive,
	sandbox,
	type Sandbox,
	script,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * The ACP contract through a real broker and real workers on a scripted model: what agentclientprotocol.com/protocol/v1
 * asks of an agent, on the wire. Every test also checks that stdout carried nothing but JSON-RPC.
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint.close();
});
afterEach((context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	killEverything();
	endpoint.requests.length = 0;
});

async function trusted(env: Record<string, string> = {}): Promise<Sandbox> {
	const box = sandbox(endpoint);
	Object.assign(box.env, env);
	seedTrust(box);
	return box;
}

function broker(box: Sandbox, answer?: Parameters<typeof acpClient>[1]) {
	const run = box.start(["--mode", "acp"], { stdin: "pipe", trust: false });
	return { run, acp: acpClient(run.process, answer) };
}

function expectOnlyProtocol(lines: readonly string[]): void {
	for (const line of lines) {
		const parsed = JSON.parse(line) as { jsonrpc?: string };
		expect(parsed.jsonrpc).toBe("2.0");
	}
}

const newSession = async (acp: ReturnType<typeof acpClient>, cwd: string) =>
	(await acp.request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] })).sessionId;

describe("initialization and malformed input", () => {
	it("negotiates the version it supports and answers every malformed message without leaving the protocol", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);

		// Before initialize: a request other than initialize gets -32600.
		const early = await acp.raw("session/list", {});
		expect(early.error?.code).toBe(-32600);

		// A version this agent does not support: it answers with the latest it does.
		const init = await acp.request<{
			protocolVersion: number;
			agentInfo: { name: string; version: string };
			authMethods: unknown[];
			agentCapabilities: {
				loadSession: boolean;
				sessionCapabilities: Record<string, unknown>;
				promptCapabilities: Record<string, unknown>;
				mcpCapabilities: Record<string, unknown>;
			};
		}>("initialize", { protocolVersion: 99, clientCapabilities: {} });
		expect(init.protocolVersion).toBe(1);
		expect(init.agentInfo.name).toBe("octocode");
		expect(init.agentCapabilities.loadSession).toBe(true);
		expect(Object.keys(init.agentCapabilities.sessionCapabilities).sort()).toEqual(["close", "list", "resume"]);

		// Not JSON: -32700 with a null id, and the connection stays up.
		acp.write("{ this is not json");
		await until(() => acp.responses.some((message) => message.error?.code === -32700), "the parse error");
		expect(acp.responses.find((message) => message.error?.code === -32700)?.id).toBeNull();

		// JSON that is not an object: -32600.
		acp.write("42");
		await until(() => acp.responses.some((message) => message.error?.code === -32600 && message.id === null), "-32600");

		expect((await acp.raw("no/such/method", {})).error?.code).toBe(-32601);
		// Capability-gated methods this agent did not advertise.
		expect((await acp.raw("session/fork", { sessionId: "x", cwd: box.project, mcpServers: [] })).error?.code).toBe(
			-32601,
		);
		expect((await acp.raw("authenticate", { methodId: "none" })).error?.code).toBe(-32601);
		// A missing and a relative cwd.
		expect((await acp.raw("session/new", { mcpServers: [] })).error?.code).toBe(-32602);
		expect((await acp.raw("session/new", { cwd: "relative/path", mcpServers: [] })).error?.code).toBe(-32602);
		expect((await acp.raw("session/new", { cwd: path.join(box.root, "gone"), mcpServers: [] })).error?.code).toBe(
			-32602,
		);
		expect((await acp.raw("session/list", { cursor: "not-a-cursor" })).error?.code).toBe(-32602);

		// Unknown sessions: -32002 naming the session; closing one still succeeds; cancelling one is not an error reply.
		const unknown = await acp.raw("session/prompt", { sessionId: "missing", prompt: [{ type: "text", text: "hi" }] });
		expect(unknown.error?.code).toBe(-32002);
		expect(unknown.error?.data?.sessionId).toBe("missing");
		expect((await acp.raw("session/close", { sessionId: "missing" })).result).toEqual({});
		const lost = await acp.raw("session/load", { sessionId: "missing", cwd: box.project, mcpServers: [] });
		expect(lost.error?.code).toBe(-32002);
		expect(lost.error?.data?.sessionId).toBe("missing");
		acp.notify("session/cancel", { sessionId: "missing" });

		// Still up after all that.
		const sessionId = await newSession(acp, box.project);
		expect((await acp.prompt(sessionId, script([{ text: "still here" }]))).stopReason).toBe("end_turn");
		expect(acp.said()).toContain("still here");

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
		expect(box.survivors()).toEqual([]);
	});

	it("a refused folder is its own error, not a missing resource, and the server stays up", async () => {
		const box = sandbox(endpoint);
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const refused = await acp.raw("session/new", { cwd: box.project, mcpServers: [] });
		// -32002 means "does not exist" and -32768 to -32000 are reserved.
		expect(refused.error?.code).not.toBe(-32002);
		expect(refused.error?.code).toBeGreaterThan(-32000);
		expect(refused.error?.message).toContain("not trusted");
		expect(refused.error?.data?.command).toContain("octocode trust add");
		expect(JSON.stringify(await acp.request("session/list", { cwd: box.project }))).toContain("sessions");
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
	});
});

describe("a prompt turn", () => {
	it("streams a tool call in order and answers after its updates", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);
		const steps = script([{ tool: "bash", args: { command: "echo acp-tool" } }, { text: "the reply" }]);
		const done = await acp.prompt(sessionId, steps);
		expect(done.stopReason).toBe("end_turn");

		const updates = acp.updates.map(({ update }) => update);
		const started = updates.findIndex((update) => update.sessionUpdate === "tool_call");
		const finished = updates.findIndex(
			(update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
		);
		const reply = updates.findIndex((update) => update.sessionUpdate === "agent_message_chunk");
		expect(started).toBeGreaterThanOrEqual(0);
		expect(finished).toBeGreaterThan(started);
		expect(reply).toBeGreaterThan(finished);
		const call = updates[started];
		expect(call?.toolCallId).toBe(updates[finished]?.toolCallId);
		// The name is what the protocol asks for, and the kind picks a client's icon.
		expect(call?.name).toBe("bash");
		expect(call?.kind).toBe("execute");
		expect(JSON.stringify(updates[finished]?.content)).toContain("acp-tool");

		// Every update of the turn precedes its response.
		const responseAt = acp.received.findIndex(
			(message) => message.result?.stopReason !== undefined && message.method === undefined,
		);
		const lastUpdateAt = acp.received.findLastIndex(
			(message) =>
				message.method === "session/update" &&
				(message.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate !==
					"available_commands_update",
		);
		expect(lastUpdateAt).toBeLessThan(responseAt);

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
	});

	it("advertises commands a prompt can run after the session starts", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		await newSession(acp, box.project);
		await until(
			() => acp.updates.some(({ update }) => update.sessionUpdate === "available_commands_update"),
			"available_commands_update",
		);
		const update = acp.updates.find(({ update: each }) => each.sessionUpdate === "available_commands_update")
			?.update as {
			availableCommands: Array<{ name: string }>;
		};
		expect(update.availableCommands.map((command) => command.name)).toContain("api");
		expect(update.availableCommands.map((command) => command.name)).not.toContain("context");
		run.process.stdin?.end();
		await run.exited;
		expectOnlyProtocol(acp.lines);
	});
});

describe("permission requests", () => {
	const permissionPrompt = (marker: string) =>
		script([{ tool: "bash", args: { command: `echo granted > ${JSON.stringify(marker)}` } }, { text: "done" }]);

	it("an allowed call runs and a rejected one does not, and neither ends the session", async () => {
		const box = await trusted({ OCTOCODE_PERMISSION: "manual" });
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);

		const allowed = path.join(box.root, "allowed");
		expect((await acp.prompt(sessionId, permissionPrompt(allowed))).stopReason).toBe("end_turn");
		expect(acp.permissions.length).toBeGreaterThan(0);
		const asked = acp.permissions[0]?.params as {
			sessionId: string;
			toolCall: { toolCallId: string; status: string };
			options: Array<{ kind: string }>;
		};
		expect(asked.sessionId).toBe(sessionId);
		expect(asked.options.map((option) => option.kind).sort()).toEqual(["allow_once", "reject_once"]);
		// The request's call is the one the client was already told about.
		expect(acp.updates.some(({ update }) => update.toolCallId === asked.toolCall.toolCallId)).toBe(true);
		expect(fs.existsSync(allowed)).toBe(true);

		acp.answers.current = "reject";
		const rejected = path.join(box.root, "rejected");
		const refused = await acp.prompt(sessionId, permissionPrompt(rejected));
		expect(refused.stopReason).toBe("end_turn");
		expect(fs.existsSync(rejected)).toBe(false);

		acp.answers.current = "allow";
		expect((await acp.prompt(sessionId, script([{ text: "after" }]))).stopReason).toBe("end_turn");

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
	});

	it("session/cancel while a permission is pending ends the turn cancelled and never runs the call", async () => {
		const box = await trusted({ OCTOCODE_PERMISSION: "manual" });
		const { run, acp } = broker(box, "hold");
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);
		const marker = path.join(box.root, "never");
		const turn = acp.prompt(sessionId, permissionPrompt(marker));
		await until(() => acp.permissions.length > 0, "the permission request");
		acp.notify("session/cancel", { sessionId });
		expect((await turn).stopReason).toBe("cancelled");
		expect(fs.existsSync(marker)).toBe(false);

		// The client's late answer to the withdrawn request does no harm, and the session goes on.
		acp.answers.current = "allow";
		expect((await acp.prompt(sessionId, script([{ text: "after cancel" }]))).stopReason).toBe("end_turn");
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
	});
});

describe("cancellation", () => {
	it("session/cancel during a model request ends the turn cancelled, and the session goes on", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);
		const hanging = script([{ hang: true }]);
		const source = hanging.slice("B64SCRIPT:".length);
		const turn = acp.prompt(sessionId, hanging);
		await until(() => endpoint.requests.some((request) => request.script === source), "the model request");
		acp.notify("session/cancel", { sessionId });
		expect((await turn).stopReason).toBe("cancelled");
		expect((await acp.prompt(sessionId, script([{ text: "after" }]))).stopReason).toBe("end_turn");
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
	});

	it("session/cancel during a running tool stops the command and ends the turn cancelled", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);
		const marker = path.join(box.root, "tool.pid");
		const turn = acp.prompt(
			sessionId,
			script([{ tool: "bash", args: { command: box.holdCommand(marker) } }, { text: "never" }]),
		);
		await until(() => fs.existsSync(marker), "the command to start");
		acp.notify("session/cancel", { sessionId });
		expect((await turn).stopReason).toBe("cancelled");
		await until(() => !alive(pidFrom(marker)), "the command to stop");
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
		expect(box.survivors()).toEqual([]);
	});

	it("$/cancel_request on a prompt also ends the turn cancelled", async () => {
		const box = await trusted();
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const sessionId = await newSession(acp, box.project);
		const hanging = script([{ hang: true }]);
		const source = hanging.slice("B64SCRIPT:".length);
		const turn = acp.raw("session/prompt", { sessionId, prompt: [{ type: "text", text: hanging }] });
		await until(() => endpoint.requests.some((request) => request.script === source), "the model request");
		// initialize was 1, session/new 2, this prompt 3.
		acp.notify("$/cancel_request", { requestId: 3 });
		const answered = await turn;
		expect(answered.result?.stopReason ?? answered.error?.code).toBe("cancelled");
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
	});
});

describe("session lifecycle across connections", () => {
	it("lists, loads with replay before the response, resumes without replay, closes", async () => {
		const box = await trusted();
		const first = broker(box);
		await first.acp.request("initialize", initialize);
		const sessionId = await newSession(first.acp, box.project);
		await first.acp.prompt(
			sessionId,
			script([{ tool: "bash", args: { command: "echo remembered-output" } }, { text: "remembered reply" }]),
		);
		const closed = await first.acp.raw("session/close", { sessionId });
		expect(closed.result).toEqual({});
		// A closed session is no longer active.
		const gone = await first.acp.raw("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] });
		expect(gone.error?.code).toBe(-32002);
		first.run.process.stdin?.end();
		expect((await first.run.exited).code).toBe(0);

		const second = broker(box);
		await second.acp.request("initialize", initialize);
		const listed = await second.acp.request<{ sessions: Array<{ sessionId: string; cwd: string; updatedAt: string }> }>(
			"session/list",
			{ cwd: box.project },
		);
		expect(listed.sessions.map((session) => session.sessionId)).toContain(sessionId);
		expect(Number.isNaN(Date.parse(listed.sessions[0]?.updatedAt ?? ""))).toBe(false);

		const loaded = await second.acp.raw("session/load", { sessionId, cwd: box.project, mcpServers: [] });
		expect(loaded.error).toBeUndefined();
		const loadResponseAt = second.acp.received.indexOf(loaded);
		const replayed = second.acp.received
			.slice(0, loadResponseAt)
			.filter((message) => message.method === "session/update")
			.map((message) => message.params?.update as { sessionUpdate: string; content?: { text?: string } });
		expect(replayed.some((update) => update.sessionUpdate === "user_message_chunk")).toBe(true);
		expect(replayed.some((update) => update.content?.text?.includes("remembered reply"))).toBe(true);
		expect(JSON.stringify(replayed)).toContain("remembered-output");
		// The conversation goes on with the model seeing what came before.
		await second.acp.prompt(sessionId, script([{ text: "continues" }]));
		expect(endpoint.requests.at(-1)?.messages.some((message) => message.text.includes("remembered reply"))).toBe(true);
		second.run.process.stdin?.end();
		expect((await second.run.exited).code).toBe(0);

		const third = broker(box);
		await third.acp.request("initialize", initialize);
		const resumed = await third.acp.raw("session/resume", { sessionId, cwd: box.project, mcpServers: [] });
		expect(resumed.error).toBeUndefined();
		const beforeResume = third.acp.received.slice(0, third.acp.received.indexOf(resumed));
		expect(
			beforeResume.filter(
				(message) =>
					message.method === "session/update" &&
					["user_message_chunk", "agent_message_chunk"].includes(
						String((message.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate),
					),
			),
		).toEqual([]);
		expect((await third.acp.prompt(sessionId, script([{ text: "resumed" }]))).stopReason).toBe("end_turn");
		third.run.process.stdin?.end();
		expect((await third.run.exited).code).toBe(0);
		for (const each of [first, second, third]) expectOnlyProtocol(each.acp.lines);
		expect(box.survivors()).toEqual([]);
	});
});

describe("a session another process has open", () => {
	it("load says who has it, and the broker goes on", async () => {
		const box = await trusted();
		const first = broker(box);
		await first.acp.request("initialize", initialize);
		const sessionId = await newSession(first.acp, box.project);
		await first.acp.prompt(sessionId, script([{ text: "first" }]));

		const second = broker(box);
		await second.acp.request("initialize", initialize);
		const refused = await second.acp.raw("session/load", { sessionId, cwd: box.project, mcpServers: [] });
		expect(refused.error?.code).toBe(-32603);
		expect(refused.error?.message).toContain("has this session open");
		// The second broker still serves, and the first still runs its session.
		const other = await newSession(second.acp, box.project);
		expect((await second.acp.prompt(other, script([{ text: "other" }]))).stopReason).toBe("end_turn");
		expect((await first.acp.prompt(sessionId, script([{ text: "still first" }]))).stopReason).toBe("end_turn");
		for (const each of [first, second]) {
			each.run.process.stdin?.end();
			expect((await each.run.exited).code).toBe(0);
			expectOnlyProtocol(each.acp.lines);
		}
	});
});

describe("client MCP servers", () => {
	it("a client-supplied stdio server's tool reaches the model and its result comes back", async () => {
		const box = await trusted();
		const server = path.join(box.root, "mcp-server.cjs");
		fs.writeFileSync(
			server,
			`const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const message = JSON.parse(line);
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	if (message.method === "initialize")
		reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
	else if (message.method === "tools/list")
		reply({ tools: [{ name: "probe", description: "Returns a marker", inputSchema: { type: "object", properties: {} } }] });
	else if (message.method === "tools/call")
		reply({ content: [{ type: "text", text: "probe-result-from-client-server " + process.env.CLIENT_VALUE }] });
	else if (message.id !== undefined) reply({});
});
`,
		);
		const { run, acp } = broker(box);
		await acp.request("initialize", initialize);
		const { sessionId } = await acp.request<{ sessionId: string }>("session/new", {
			cwd: box.project,
			mcpServers: [
				{
					name: "fixture",
					command: process.execPath,
					args: [server],
					env: [{ name: "CLIENT_VALUE", value: "supplied" }],
				},
			],
		});
		await acp.prompt(sessionId, script([{ text: "first" }]));
		const declared = endpoint.requests.at(-1)?.tools ?? [];
		const tool = declared.find((name) => name.startsWith("acp_") || name.includes("probe"));
		expect(tool, `declared: ${declared.join(", ")}`).toBeDefined();
		await acp.prompt(sessionId, script([{ tool: tool!, args: {} }, { text: "used it" }]));
		expect(endpoint.requests.at(-1)?.toolResults.join("\n")).toContain("probe-result-from-client-server supplied");

		// A relative command is refused before anything starts.
		const relative = await acp.raw("session/new", {
			cwd: box.project,
			mcpServers: [{ name: "bad", command: "node", args: [], env: [] }],
		});
		expect(relative.error?.code).toBe(-32602);
		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expectOnlyProtocol(acp.lines);
		expect(box.survivors()).toEqual([]);
	});
});
