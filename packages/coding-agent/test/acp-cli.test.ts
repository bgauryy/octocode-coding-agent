import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { methods, PROTOCOL_VERSION, type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { runAcpMain } from "../src/main/acp-host.ts";
import { acpWorkerArguments } from "../../acp/src/server/acp-mode.ts";
import { choose, startAcpAgent, type AcpAgent } from "./helpers/feature-host-acp.ts";
import {
	createSandbox,
	observeSessions,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

let sandbox: Sandbox;
let server: ModelServer | undefined;
let agent: AcpAgent | undefined;

afterEach(async () => {
	if (agent && agent.child.exitCode === null && agent.child.signalCode === null) agent.child.kill("SIGKILL");
	await agent?.stop();
	await server?.close();
	sandbox?.cleanup();
	agent = undefined;
	server = undefined;
});

describe("ACP CLI", () => {
	it("accepts ACP and passes native runtime options to each RPC worker", () => {
		const args = ["--mode", "acp", "--provider", "openai", "--model", "fixture", "--no-mcp"];
		const parsed = parseArgs(args);
		expect(parsed.mode).toBe("acp");
		expect(parsed.diagnostics).toEqual([]);
		expect(acpWorkerArguments(args, parsed)).toEqual(args.slice(2));
	});

	it.each([
		["positional prompt"],
		["@file.ts"],
		["--print"],
		["--continue"],
		["--resume"],
		["--session", "fixture.jsonl"],
		["--session-id", "fixture"],
		["--fork", "fixture"],
		["--export", "fixture.jsonl"],
		["--list-models"],
		["--no-session"],
	])("rejects CLI-owned prompts and session selection: %j", (...extra) => {
		const args = ["--mode", "acp", ...extra];
		expect(() => acpWorkerArguments(args, parseArgs(args))).toThrow(
			"receives prompts and new-session requests over stdin",
		);
	});

	it("prints one refusal and exits non-zero for invalid ACP arguments, without a stack", async () => {
		const args = ["--mode", "acp", "--print"];
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const exitCode = process.exitCode;
		try {
			await runAcpMain(args, parseArgs(args));
			expect(process.exitCode).toBe(1);
			expect(errors.mock.calls).toHaveLength(1);
			expect(String(errors.mock.calls[0][0])).toContain("ACP mode receives prompts");
			expect(String(errors.mock.calls[0][0])).not.toContain("\n    at ");
		} finally {
			process.exitCode = exitCode;
			errors.mockRestore();
		}
	});

	it.each(process.platform === "win32" ? (["session/close"] as const) : (["session/close", "SIGTERM"] as const))(
		"roundtrips real worker prompts and permissions, then cleans up on %s",
		async (shutdownMode) => {
			sandbox = createSandbox({ OCTOCODE_PERMISSION: "manual" });
			const sessions = observeSessions(sandbox);
			server = await startModelServer([
				{ tool: "bash", args: { command: "echo allowed > allowed.txt" } },
				{ text: "first done" },
				{ tool: "bash", args: { command: "echo denied > denied.txt" } },
				{ text: "second done" },
			]);
			writeScriptedProvider(sandbox, server);
			const permissions: RequestPermissionRequest[] = [];
			const current = startAcpAgent(sandbox, {
				permission: (params) => {
					permissions.push(params);
					return choose(params, permissions.length === 1 ? "allow_once" : "reject_once");
				},
			});
			agent = current;
			const response = await current.connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
			expect(response.agentInfo?.name).toBe("octocode");
			const sessionId = await current.newSession();
			expect(sessionId).toEqual(expect.any(String));
			const existing = await current.connection.agent.request(methods.agent.session.list, { cwd: sandbox.project });
			expect(existing.sessions).toMatchObject([{ sessionId, cwd: realpathSync(sandbox.project) }]);
			await expect(current.connection.agent.request(methods.agent.session.close, { sessionId })).resolves.toEqual({});
			await expect(
				current.connection.agent.request(methods.agent.session.resume, {
					cwd: sandbox.project,
					sessionId,
					mcpServers: [],
				}),
			).resolves.toEqual({ configOptions: [expect.objectContaining({ id: "model" })] });
			for (const text of ["allow the call", "deny the call"]) {
				await expect(current.prompt(sessionId, text), current.diagnostics()).resolves.toMatchObject({
					stopReason: "end_turn",
				});
			}
			expect(permissions).toHaveLength(2);
			expect(permissions.every((request) => request.sessionId === sessionId)).toBe(true);
			expect(permissions[0].toolCall.toolCallId).toBe("call_1");
			expect(readFileSync(join(sandbox.project, "allowed.txt"), "utf8").trim()).toBe("allowed");
			expect(existsSync(join(sandbox.project, "denied.txt"))).toBe(false);
			// The first worker ended with `session/close`; the resumed one answered both prompts.
			await vi.waitFor(() => expect(new Set(sessions.started()).size).toBe(2), { timeout: 20_000 });
			const worker = sessions.started().at(-1)!;
			expect(worker).not.toBe(current.child.pid);
			if (shutdownMode === "session/close") {
				await expect(current.connection.agent.request(methods.agent.session.close, { sessionId })).resolves.toEqual({});
				expect(sessions.ended()).toContain(worker);
				expect(() => process.kill(worker, 0)).toThrow();
				current.child.stdin.end();
			} else {
				current.child.kill("SIGTERM");
			}
			const [code, signal] = await current.exited;
			expect({ code, signal }, current.diagnostics()).toEqual({
				code: shutdownMode === "SIGTERM" ? 143 : 0,
				signal: null,
			});
			expect(sessions.ended()).toContain(worker);
			expect(() => process.kill(worker, 0)).toThrow();
			// Standard output carries protocol messages only.
			const messages = current
				.output()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(messages[0]).toMatchObject({ jsonrpc: "2.0", result: { protocolVersion: PROTOCOL_VERSION } });
			expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
		},
		120_000,
	);
});
