import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { getCliInvocation } from "../src/config.ts";
import { acpWorkerArguments } from "../../acp/src/server/acp-mode.ts";

const children: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const closed = once(child, "close");
			child.kill("SIGKILL");
			await closed;
		}),
	);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ACP CLI", () => {
	it("accepts ACP and passes native runtime options to each RPC worker", () => {
		const args = [
			"--mode",
			"acp",
			"--provider",
			"openai",
			"--model",
			"fixture",
			"--no-mcp",
			"--custom-option",
			"value",
		];
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

	it.each(process.platform === "win32" ? (["session/close"] as const) : (["session/close", "SIGTERM"] as const))(
		"roundtrips real worker prompts and permissions, then cleans up on %s",
		async (shutdownMode) => {
			const directory = mkdtempSync(join(tmpdir(), "octocode-acp-cli-"));
			directories.push(directory);
			const extension = join(directory, "permission-fixture.mjs");
			const choices = join(directory, "choices.jsonl");
			const shutdown = join(directory, "shutdown.json");
			writeFileSync(
				extension,
				`import { appendFileSync, writeFileSync } from "node:fs";
export default function(api) {
  api.on("input", async (_event, context) => {
    const choice = await context.ui.select("Fixture permission", ["Allow once", "Deny"], {
      permission: { toolCallId: "fixture-call", toolName: "fixture", action: "fixture.check", targets: ["fixture-target"], allowOnce: "Allow once", rejectOnce: "Deny" }
    });
    appendFileSync(${JSON.stringify(choices)}, JSON.stringify({ choice, pid: process.pid }) + "\\n");
    return { action: "handled" };
  });
  api.on("session_shutdown", async () => {
    writeFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ pid: process.pid }));
  });
}
`,
			);
			const invocation = getCliInvocation();
			const child = spawn(
				invocation.command,
				[
					...invocation.prefix,
					"--mode",
					"acp",
					"--no-mcp",
					"--no-builtin-tools",
					"--no-extensions",
					"--extension",
					extension,
					"--no-skills",
					"--no-context-files",
					"--offline",
					"--provider",
					"openai",
					"--model",
					"gpt-4o-mini",
				],
				{
					cwd: directory,
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
						HOME: directory,
						USERPROFILE: directory,
						TMPDIR: tmpdir(),
						OCTOCODE_HOME: join(directory, "octocode"),
						PI_CODING_AGENT_DIR: join(directory, "pi"),
						OCTOCODE_OFFLINE: "1",
						OCTOCODE_MCP: "0",
						OCTOCODE_MODELS_DEV: "0",
						OCTOCODE_API: "0",
					},
				},
			);
			children.push(child);
			let output = "";
			let diagnostics = "";
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				diagnostics += chunk.toString();
			});
			const exited = once(child, "close");
			const permissions: RequestPermissionRequest[] = [];
			const connection = client({ name: "octocode-cli-test" })
				.onRequest(methods.client.session.requestPermission, ({ params }) => {
					permissions.push(params);
					const kind = permissions.length === 1 ? "allow_once" : "reject_once";
					return {
						outcome: { outcome: "selected", optionId: params.options.find((option) => option.kind === kind)!.optionId },
					};
				})
				.connect(
					ndJsonStream(
						Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
						Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
					),
				);
			try {
				const response = await connection.agent.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {},
				});
				expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
				expect(response.agentInfo?.name).toBe("octocode");
				const session = await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] });
				expect(session.sessionId).toEqual(expect.any(String));
				const existing = await connection.agent.request(methods.agent.session.list, { cwd: directory });
				expect(existing.sessions).toMatchObject([{ sessionId: session.sessionId, cwd: realpathSync(directory) }]);
				await expect(
					connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId }),
				).resolves.toEqual({});
				await expect(
					connection.agent.request(methods.agent.session.resume, {
						cwd: directory,
						sessionId: session.sessionId,
						mcpServers: [],
					}),
				).resolves.toEqual({});
				for (const text of ["allow fixture", "deny fixture"]) {
					await expect(
						connection.agent.request(methods.agent.session.prompt, {
							sessionId: session.sessionId,
							prompt: [{ type: "text", text }],
						}),
					).resolves.toMatchObject({ stopReason: "end_turn" });
				}
				expect(permissions).toHaveLength(2);
				expect(permissions.every((request) => request.sessionId === session.sessionId)).toBe(true);
				expect(permissions[0].toolCall.toolCallId).toBe("fixture-call");
				const selections = readFileSync(choices, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(selections.map((selection) => selection.choice)).toEqual(["Allow once", "Deny"]);
				expect(selections[0].pid).toBe(selections[1].pid);
				expect(selections[0].pid).not.toBe(child.pid);
				if (shutdownMode === "session/close") {
					await expect(
						connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId }),
					).resolves.toEqual({});
					expect(JSON.parse(readFileSync(shutdown, "utf8"))).toEqual({ pid: selections[0].pid });
					expect(() => process.kill(selections[0].pid, 0)).toThrow();
					child.stdin.end();
				} else {
					child.kill("SIGTERM");
				}
				const [code, signal] = await exited;
				expect({ code, signal }, diagnostics).toEqual({ code: shutdownMode === "SIGTERM" ? 143 : 0, signal: null });
				expect(JSON.parse(readFileSync(shutdown, "utf8"))).toEqual({ pid: selections[0].pid });
				expect(() => process.kill(selections[0].pid, 0)).toThrow();
				const messages = output
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(messages).toHaveLength(shutdownMode === "session/close" ? 10 : 9);
				expect(messages[0]).toMatchObject({ jsonrpc: "2.0", result: { protocolVersion: PROTOCOL_VERSION } });
			} finally {
				connection.close();
			}
		},
	);
});
