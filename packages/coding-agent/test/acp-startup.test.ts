import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";

it.each(["work", "dialog", "permission", "cancel", "cancel-response", "close", "eof"])(
	"projects awaited startup %s under its canonical identity on new and load",
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "octocode-acp-command-"));
		const extension = join(directory, "command-fixture.mjs");
		const journal = join(directory, "runs.jsonl");
		const streamModule = fileURLToPath(new URL("../../ai/src/utils/event-stream.ts", import.meta.url));
		writeFileSync(
			extension,
			`import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(streamModule)};
export default function(api) {
  api.registerProvider("acp-command-fixture", {
    api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture-key",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "fixture response" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "started" }) + "\\n");
      setTimeout(() => {
        appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "finished" }) + "\\n");
        stream.push({ type: "done", reason: "stop", message });
      }, 250);
      return stream;
    }
  });
  let asked = false;
  api.on("before_agent_start", async (_event, context) => {
    if (!["permission", "cancel", "cancel-response", "close", "eof"].includes(${JSON.stringify(mode)}) || asked) return;
    asked = true;
    const answer = await context.ui.select("Allow startup fixture?", ["Allow", "Deny"], {
      permission: { toolName: "fixture", action: "file.write", targets: ["fixture"], allowOnce: "Allow", rejectOnce: "Deny" }
    });
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "permission", answer }) + "\\n");
    if (answer !== "Allow") throw new Error("Startup permission was not granted");
  });
  api.on("session_start", async (_event, context) => {
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "session", id: context.sessionManager.getSessionId() }) + "\\n");
    if (${JSON.stringify(mode)} === "dialog") {
      const answer = await context.ui.select("Unsupported startup question", ["One", "Two"]);
      appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "dialog", cancelled: answer === undefined }) + "\\n");
    }
    const pending = api.sendMessage({ customType: "startup-work", content: "startup autonomous work", display: true }, { triggerTurn: true });
    api.sendMessage({ customType: "startup-note", content: "startup note", display: true }, { triggerTurn: false });
    await pending;
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
				"acp-command-fixture",
				"--model",
				"fixture",
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
		let diagnostics = "";
		child.stderr.on("data", (chunk) => {
			diagnostics += chunk.toString();
		});
		const exited = once(child, "close");
		const updates: SessionNotification[] = [];
		const permissions: string[] = [];
		const connection = client({ name: "acp-command-lifecycle-test" })
			.onNotification(methods.client.session.update, ({ params }) => {
				updates.push(params);
			})
			.onRequest(methods.client.session.requestPermission, async ({ params }) => {
				permissions.push(params.sessionId);
				if (mode === "cancel") {
					await connection.agent.notify(methods.agent.session.cancel, { sessionId: params.sessionId });
					return { outcome: { outcome: "cancelled" } };
				}
				if (mode === "cancel-response") return { outcome: { outcome: "cancelled" } };
				if (mode === "close") {
					await connection.agent.request(methods.agent.session.close, { sessionId: params.sessionId });
					return { outcome: { outcome: "cancelled" } };
				}
				if (mode === "eof") {
					child.stdin.end();
					return { outcome: { outcome: "cancelled" } };
				}
				return { outcome: { outcome: "selected", optionId: "allow-once" } };
			})
			.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
		try {
			await connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const creation = Promise.race([
				connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] }),
				new Promise<never>((_resolve, reject) => {
					// Startup alone takes about 4s when the machine is idle; a real deadlock never resolves, so 20s still detects it.
					deadline = setTimeout(() => reject(new Error("Startup dialog deadlocked")), 20_000);
				}),
			]).finally(() => clearTimeout(deadline));
			if (mode === "close" || mode === "eof") {
				await expect(creation).rejects.toThrow();
				expect(permissions).toHaveLength(1);
				return;
			}
			const session = await creation;
			if (mode === "cancel" || mode === "cancel-response") {
				expect(permissions).toEqual([session.sessionId]);
				expect(readFileSync(journal, "utf8")).not.toContain('"started"');
				await expect(
					connection.agent.request(methods.agent.session.prompt, {
						sessionId: session.sessionId,
						prompt: [{ type: "text", text: "after startup cancellation" }],
					}),
				).resolves.toMatchObject({ stopReason: "end_turn" });
				return;
			}
			await vi.waitFor(() => expect(readFileSync(journal, "utf8")).toContain('"finished"'));
			await connection.agent.request(methods.agent.session.list, { cwd: directory });
			const messages = updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk");
			expect(messages, diagnostics).toHaveLength(1);
			expect.soft(updates.every((update) => update.sessionId === session.sessionId)).toBe(true);
			expect
				.soft(
					updates.some(
						({ update }) =>
							update.sessionUpdate === "user_message_chunk" &&
							update.content.type === "text" &&
							update.content.text === "startup note",
					),
				)
				.toBe(true);
			await connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId });
			updates.length = 0;
			writeFileSync(journal, "");
			await connection.agent.request(methods.agent.session.load, {
				cwd: directory,
				sessionId: session.sessionId,
				mcpServers: [],
			});
			await vi.waitFor(() => expect(readFileSync(journal, "utf8")).toContain('"finished"'));
			await connection.agent.request(methods.agent.session.list, { cwd: directory });
			const starts = readFileSync(journal, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.event === "session");
			expect.soft(starts.map((entry) => entry.id)).toEqual([session.sessionId]);
			expect(updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
			expect(updates.every((update) => update.sessionId === session.sessionId)).toBe(true);
			if (mode === "permission") expect(permissions).toEqual([session.sessionId, session.sessionId]);
			if (mode === "dialog") expect(readFileSync(journal, "utf8")).toContain('"cancelled":true');
		} finally {
			connection.close();
			child.stdin.end();
			await exited;
			rmSync(directory, { recursive: true, force: true });
		}
	},
	60_000,
);
