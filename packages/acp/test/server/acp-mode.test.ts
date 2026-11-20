import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { assistant, deferred, FakeWorker, harness } from "./acp-test-harness.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("inbound ACP protocol", () => {
	it("requires initialization and advertises its supported protocol version", async () => {
		const h = harness();
		await expect(h.newSession()).rejects.toThrow();
		expect(h.createWorker).not.toHaveBeenCalled();
		const response = await h.initialize(PROTOCOL_VERSION + 1);
		expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(response.agentCapabilities?.loadSession).toBe(true);
		expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({});
		expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
		expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
		expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
		expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(false);
		expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
		await expect(h.initialize()).rejects.toThrow();
	});

	it("validates cwd and MCP transports before allocating a worker; forwards stdio definitions exactly", async () => {
		const h = harness();
		await h.initialize();
		await expect(h.newSession("relative-directory")).rejects.toThrow();
		await expect(h.newSession("/missing-octocode-acp-directory")).rejects.toThrow();
		await expect(
			h.connection.agent.request(methods.agent.session.new, {
				cwd: process.cwd(),
				mcpServers: [],
				additionalDirectories: [process.cwd()],
			}),
		).rejects.toThrow("Additional workspace directories are unsupported");
		expect(h.createWorker).not.toHaveBeenCalled();
		const http = [{ type: "http" as const, name: "remote", url: "https://example.com/mcp", headers: [] }];
		await h.newSession(process.cwd(), http);
		expect(h.createWorker).toHaveBeenCalledWith(process.cwd(), http, undefined);
		const definitions = [
			{
				name: "fixture",
				command: "fixture-command",
				args: ["arg"],
				env: [{ name: "FIXTURE", value: "literal-${VALUE}" }],
			},
		];
		const created = await h.newSession(process.cwd(), definitions);
		expect(h.createWorker).toHaveBeenCalledWith(process.cwd(), definitions, undefined);
		expect(h.workers[1].start).toHaveBeenCalledOnce();
		expect(h.workers[1].getState).toHaveBeenCalledOnce();
		expect(created.sessionId).toBe((await h.workers[1].getState()).sessionId);
	});

	it("refuses a session in a folder the user has not trusted, naming the command, before allocating a worker", async () => {
		const h = harness({
			folderTrust: (cwd) => ({
				trusted: false,
				message: `Folder is not trusted: ${cwd}`,
				command: `octocode trust add ${cwd}`,
			}),
		});
		await h.initialize();
		const refused = await h.newSession().catch((error: unknown) => error);
		expect(refused).toMatchObject({
			code: -31000,
			message: expect.stringContaining("Folder is not trusted"),
			data: { command: expect.stringContaining("octocode trust add") },
		});
		expect(h.createWorker).not.toHaveBeenCalled();
	});

	it("limits pending session creation and cleans a worker whose readiness fails", async () => {
		const gate = deferred<FakeWorker>();
		const h = harness({ maxSessions: 1, createWorker: () => gate.promise });
		await h.initialize();
		const first = h.newSession();
		await expect.poll(() => h.createWorker.mock.calls.length).toBe(1);
		await expect(h.newSession()).rejects.toThrow();
		const worker = new FakeWorker();
		worker.getState.mockRejectedValueOnce(new Error("startup failure"));
		const failed = expect(first).rejects.toThrow("Could not start the Octocode session");
		gate.resolve(worker);
		await failed;
		expect(worker.stop).toHaveBeenCalledOnce();
		h.createWorker.mockResolvedValueOnce(new FakeWorker());
		await expect(h.newSession()).resolves.toHaveProperty("sessionId");
	});

	it("releases the broker slot when a worker closes unexpectedly", async () => {
		const h = harness({ maxSessions: 1 });
		await h.initialize();
		const first = await h.newSession();
		h.workers[0].fail();
		await expect(h.prompt(first.sessionId)).rejects.toThrow();
		await expect(h.newSession()).resolves.toHaveProperty("sessionId");
		await expect.poll(() => h.workers[0].stop.mock.calls.length).toBe(1);
	});

	it("rejects unknown sessions without dispatching work", async () => {
		const h = harness();
		await h.initialize();
		await h.newSession();
		await expect(h.prompt("unknown-session")).rejects.toThrow();
		expect(h.workers[0].prompt).not.toHaveBeenCalled();
	});

	it("refuses concurrent prompts within a session while other sessions proceed independently", async () => {
		const h = harness();
		await h.initialize();
		const a = await h.newSession();
		const b = await h.newSession();
		const first = h.prompt(a.sessionId, "first");
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		await expect(h.prompt(a.sessionId, "duplicate")).rejects.toThrow();
		const second = h.prompt(b.sessionId, "other");
		await expect.poll(() => h.workers[1].prompt.mock.calls.length).toBe(1);
		h.workers[1].finish("B");
		await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
		h.workers[0].finish("A");
		await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(h.workers[0].prompt).toHaveBeenCalledTimes(1);
		expect(h.updates.filter((event) => event.sessionId === b.sessionId)).not.toHaveLength(0);
	});

	it("rejects unsupported content before any prompt, and preserves supported text, image and resource evidence", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		await expect(
			h.connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
			}),
		).rejects.toThrow();
		await expect(
			h.connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "resource", resource: { uri: "file:///fixture", blob: "aGVsbG8=" } }],
			}),
		).rejects.toThrow();
		await expect(
			h.connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "image", data: "invalid-base64!", mimeType: "image/png" }],
			}),
		).rejects.toThrow();
		expect(h.workers[0].prompt).not.toHaveBeenCalled();
		const run = h.connection.agent.request(methods.agent.session.prompt, {
			sessionId,
			prompt: [
				{ type: "text", text: "Inspect" },
				{ type: "resource_link", name: "dependency", uri: "https://example.com/source.ts" },
				{ type: "resource", resource: { uri: "file:///provided.ts", text: "export const value = 1;" } },
				{ type: "image", data: PNG, mimeType: "image/png" },
			],
		});
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		const [text, images] = h.workers[0].prompt.mock.calls[0];
		expect(text).toContain("Inspect");
		expect(text).toContain("https://example.com/source.ts");
		expect(text).toContain("export const value = 1;");
		expect(images).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
		h.workers[0].finish();
		await run;
	});

	it("delivers ordered public text and tool updates before completion without replaying final text or thoughts", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		const worker = h.workers[0];
		worker.emit({ type: "message_start", message: assistant("") });
		worker.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
		});
		worker.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "private thinking" },
		});
		worker.emit({ type: "message_end", message: assistant("Hello world") });
		worker.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "file", args: { path: "a.ts" } });
		worker.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "file",
			result: { content: [{ type: "text", text: "saved" }] },
			isError: false,
		});
		worker.emit({ type: "agent_settled", aborted: false });
		await expect(run).resolves.toMatchObject({ stopReason: "end_turn" });
		const texts = h.updates.flatMap(({ update }) =>
			update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
		);
		expect(texts.join("")).toBe("Hello world");
		expect(h.updates.some(({ update }) => update.sessionUpdate === "agent_thought_chunk")).toBe(false);
		expect(h.updates.map(({ update }) => update.sessionUpdate)).toEqual([
			"agent_message_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
		]);
		expect(h.updates.at(-1)?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
	});

	it("settles cancellation when the worker acknowledges it and permits a later prompt", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		await h.cancel(sessionId);
		await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(h.workers[0].abort).toHaveBeenCalledOnce();
		expect(h.workers[0].stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(2);
		h.workers[0].finish();
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("closes an unresponsive cancelled worker and settles its original prompt", async () => {
		const h = harness({ cancelTimeoutMs: 20 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		h.workers[0].abort.mockImplementation(() => new Promise(() => {}));
		const logged = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		await h.cancel(sessionId);
		await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
		const reported = String(logged.mock.calls[0]?.[0]);
		expect(reported).toContain("ACP cancellation did not complete");
		expect(reported).toContain("Cancellation deadline");
		logged.mockRestore();
		expect(h.workers[0].stop).toHaveBeenCalledOnce();
		await expect(h.prompt(sessionId)).rejects.toThrow();
	});

	it("fails an active prompt on unexpected worker death instead of reporting end_turn", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const failed = expect(h.prompt(sessionId)).rejects.toThrow("Agent process closed");
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].fail();
		await failed;
	});

	it("does not turn a settled model error into successful completion", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const failed = expect(h.prompt(sessionId)).rejects.toThrow();
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].emit({
			type: "message_end",
			message: { ...assistant("", "error"), errorMessage: "provider unavailable" },
		});
		h.workers[0].emit({ type: "agent_settled", aborted: false });
		await failed;
	});

	it("completes an extension-handled prompt without waiting for a run that never starts", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		h.workers[0].prompt.mockResolvedValueOnce("handled");
		await expect(h.prompt(sessionId, "/extension-command")).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("ends a prompt the worker stopped before taking it as cancelled, without waiting for a run", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		h.workers[0].prompt.mockResolvedValueOnce("not-sent");
		await expect(h.prompt(sessionId)).resolves.toMatchObject({ stopReason: "cancelled" });
	});

	it("waits for prompt acceptance even if execution settles before the RPC response arrives", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const accepted = deferred<string>();
		h.workers[0].prompt.mockImplementationOnce(() => accepted.promise);
		let completed = false;
		const run = h.prompt(sessionId).then((response) => {
			completed = true;
			return response;
		});
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].finish();
		await expect.poll(() => h.updates.length).toBe(1);
		expect(completed).toBe(false);
		accepted.resolve("started");
		await expect(run).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("rejects failed dispatch and never retries a prompt whose execution is uncertain", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		h.workers[0].prompt.mockRejectedValueOnce(new Error("RPC response lost"));
		await expect(h.prompt(sessionId)).rejects.toThrow();
		expect(h.workers[0].prompt).toHaveBeenCalledOnce();
		await expect.poll(() => h.workers[0].stop.mock.calls.length).toBe(1);
		h.workers[0].finish("late output from an uncertain execution");
		await expect(h.prompt(sessionId)).rejects.toThrow();
		expect(h.updates).toHaveLength(0);
	});

	it("fails and closes a worker when output exceeds the connection's bounded queue", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const failed = expect(h.prompt(sessionId)).rejects.toThrow();
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].emit({ type: "message_end", message: assistant("x".repeat(3 * 1024 * 1024)) });
		await failed;
		expect(h.workers[0].stop).toHaveBeenCalledOnce();
		expect(h.updates).toHaveLength(0);
	});

	it("closes every owned worker when the client disconnects", async () => {
		const h = harness();
		await h.initialize();
		const a = await h.newSession();
		await h.newSession();
		const failed = expect(h.prompt(a.sessionId)).rejects.toThrow();
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.disconnect();
		await failed;
		await expect.poll(() => h.workers.map((worker) => worker.stop.mock.calls.length)).toEqual([1, 1]);
	});

	it("does not finish shutdown until the worker has actually stopped", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		const failed = expect(run).rejects.toThrow();
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		const stopped = deferred<void>();
		h.workers[0].stop.mockImplementationOnce(async () => {
			h.workers[0].fail(new Error("Stop initiated"));
			await stopped.promise;
		});
		let completed = false;
		const closing = h.broker.close().then(() => {
			completed = true;
		});
		await expect.poll(() => h.workers[0].stop.mock.calls.length).toBe(1);
		expect(completed).toBe(false);
		stopped.resolve();
		await closing;
		h.connection.close();
		await failed;
		expect(h.workers[0].stop).toHaveBeenCalledOnce();
	});

	it("closes a worker that finishes startup after broker shutdown", async () => {
		const pending = deferred<FakeWorker>();
		const h = harness({ createWorker: () => pending.promise });
		await h.initialize();
		const failed = expect(h.newSession()).rejects.toThrow();
		await expect.poll(() => h.createWorker.mock.calls.length).toBe(1);
		const closing = h.broker.close();
		const worker = new FakeWorker();
		pending.resolve(worker);
		await closing;
		// A broker owns the agent endpoint; its stdio host owns physically closing the peer transport.
		h.connection.close();
		await failed;
		expect(worker.stop).toHaveBeenCalledOnce();
	});
});
