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

it("waits for a command-started model run and delivers its response before completing the ACP prompt", async () => {
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
      if (JSON.stringify(context.messages.findLast((item) => item.role === "user")?.content).includes("cancel this model")) {
        const abort = () => {
          appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "cancelled" }) + "\\n");
          stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
        return stream;
      }
      setTimeout(() => {
        appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "finished" }) + "\\n");
        stream.push({ type: "done", reason: "stop", message });
      }, 250);
      return stream;
    }
  });
  api.registerCommand("acprun", { handler: async () => {
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ event: "command" }) + "\\n");
    api.sendUserMessage("command-generated prompt");
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
		await expect(prompt("plain prompt"), diagnostics).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text === "fixture response",
			),
			diagnostics,
		).toBe(true);
		updates.length = 0;
		await expect(prompt("/acprun"), diagnostics).resolves.toMatchObject({ stopReason: "end_turn" });
		const events = () =>
			readFileSync(journal, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).event);
		const eventsAtResponse = events();
		const updatesAtResponse = [...updates];
		await vi.waitFor(() =>
			expect(events(), diagnostics).toEqual(["started", "finished", "command", "started", "finished"]),
		);
		expect(eventsAtResponse, diagnostics).toEqual(["started", "finished", "command", "started", "finished"]);
		expect(
			updatesAtResponse.some(
				({ update }) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text === "fixture response",
			),
			diagnostics,
		).toBe(true);
		const cancelled = prompt("cancel this model");
		await vi.waitFor(() => expect(events().at(-1)).toBe("started"));
		await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
		await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(events().at(-1)).toBe("cancelled");
		await expect(prompt("after cancellation"), diagnostics).resolves.toMatchObject({ stopReason: "end_turn" });
	} finally {
		connection.close();
		child.stdin.end();
		await exited;
		rmSync(directory, { recursive: true, force: true });
	}
});
