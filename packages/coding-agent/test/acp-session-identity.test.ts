import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";

it.each(["new", "switch", "fork"])(
	"refuses %s from extension commands before replacing an ACP-owned session",
	async (operation) => {
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
  api.on("session_start", (_event, context) => {
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "session", id: context.sessionManager.getSessionId() }) + "\\n");

  });
  api.registerCommand("rotate", { handler: async (operation, context) => {
    try {
      if (operation === "new") await context.newSession();
      else if (operation === "switch") await context.switchSession(context.sessionManager.getSessionFile());
      else await context.fork(context.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user").id);
      appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "control", result: "allowed" }) + "\\n");
    } catch (error) {
      appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "control", result: error.message }) + "\\n");
      throw error;
    }
  } });
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
		const connection = client({ name: "acp-command-lifecycle-test" })
			.onNotification(methods.client.session.update, ({ params }) => {
				updates.push(params);
			})
			.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
		try {
			await connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			const session = await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] });
			const prompt = (text: string) =>
				connection.agent.request(methods.agent.session.prompt, {
					sessionId: session.sessionId,
					prompt: [{ type: "text", text }],
				});
			await prompt("before rotation");
			await expect(prompt(`/rotate ${operation}`)).rejects.toThrow("ACP owns session selection");
			const entries = readFileSync(journal, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect.soft(entries.find((entry) => entry.event === "control")?.result).toContain("ACP owns session selection");
			expect
				.soft(entries.filter((entry) => entry.event === "session").map((entry) => entry.id))
				.toEqual([session.sessionId]);
			await expect(prompt("after refused rotation")).resolves.toMatchObject({ stopReason: "end_turn" });
		} finally {
			connection.close();
			child.stdin.end();
			await exited;
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
