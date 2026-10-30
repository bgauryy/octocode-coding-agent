import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../coding-agent/src/core/session-manager.ts";
import { assistant, FakeWorker, harness } from "./acp-test-harness.ts";

describe("ACP persistent sessions", () => {
	let cwd: string;
	let home: string;
	beforeEach(async () => {
		cwd = await realpath(await mkdtemp(join(tmpdir(), "acp-history-work-")));
		home = await mkdtemp(join(tmpdir(), "acp-history-home-"));
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", home);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	});

	function transcript() {
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 1 });
		manager.appendMessage(assistant("earlier answer"));
		return { id: manager.getSessionId(), path: manager.getSessionFile()! };
	}

	it("replays images and visible external messages, preserving hidden-context boundaries", async () => {
		const manager = SessionManager.create(cwd);
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5m8AAAAASUVORK5CYII=",
		};
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 1 });
		manager.appendCustomMessageEntry("octocode-external", "External client: question", true);
		manager.appendCustomMessageEntry("internal-context", "private context", false);
		manager.appendMessage(assistant("answer"));
		const worker = new FakeWorker();
		const state = await worker.getState();
		worker.getState.mockResolvedValue({
			...state,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
		});
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		await h.connection.agent.request(methods.agent.session.load, {
			cwd,
			sessionId: manager.getSessionId(),
			mcpServers: [],
		});
		expect(h.updates.map(({ update }) => update)).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "look" } },
			{ sessionUpdate: "user_message_chunk", content: image },
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "External client: question" },
				_meta: { "octocode/customType": "octocode-external" },
			},
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
		]);
	});

	it("lists durable IDs and replays ordered messages before load resolves", async () => {
		const saved = transcript();
		const worker = new FakeWorker();
		worker.getState.mockImplementation(async () => ({
			sessionId: saved.id,
			sessionFile: saved.path,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messageCount: 2,
			pendingMessageCount: 0,
		}));
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		const list = await h.connection.agent.request(methods.agent.session.list, { cwd });
		expect(list.sessions).toMatchObject([{ sessionId: saved.id, cwd }]);
		await expect(
			h.connection.agent.request(methods.agent.session.load, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).resolves.toEqual({});
		expect(h.createWorker).toHaveBeenCalledWith(cwd, [], saved.path);
		expect(h.updates.map(({ update }) => update)).toMatchObject([
			{ sessionUpdate: "user_message_chunk", content: { text: "earlier question" } },
			{ sessionUpdate: "agent_message_chunk", content: { text: "earlier answer" } },
		]);
		await expect(
			h.connection.agent.request(methods.agent.session.resume, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).resolves.toEqual({});
		expect(h.updates).toHaveLength(2);
	});

	it("resume restores without replay and rejects a different workspace", async () => {
		const saved = transcript();
		const worker = new FakeWorker();
		worker.getState.mockResolvedValue({
			sessionId: saved.id,
			sessionFile: saved.path,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messageCount: 2,
			pendingMessageCount: 0,
		});
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		await expect(
			h.connection.agent.request(methods.agent.session.resume, {
				cwd: home,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).rejects.toThrow();
		expect(worker.start).not.toHaveBeenCalled();
		await expect(
			h.connection.agent.request(methods.agent.session.resume, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).resolves.toEqual({});
		expect(h.updates).toEqual([]);
	});

	it("rejects a restored worker's wrong startup identity before replay or live output", async () => {
		const saved = transcript();
		const worker = new FakeWorker();
		worker.start.mockImplementationOnce(async () => worker.identify("wrong-restored-id"));
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		await expect(
			h.connection.agent.request(methods.agent.session.load, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).rejects.toThrow();
		expect(worker.stop).toHaveBeenCalledOnce();
		expect(h.updates).toEqual([]);
	});

	it("stops a worker if transcript restoration fails without replaying history", async () => {
		const saved = transcript();
		const worker = new FakeWorker();
		worker.start.mockRejectedValueOnce(new Error("native load failed"));
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		await expect(
			h.connection.agent.request(methods.agent.session.load, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).rejects.toThrow("Could not start");
		expect(worker.stop).toHaveBeenCalledOnce();
		expect(h.updates).toEqual([]);
	});

	it.each([
		["complete", "changed one file", "changed one file"],
		[
			"truncated",
			"x".repeat(30_000),
			`${"x".repeat(4_000)}\n[Tool output truncated for ACP: 14100 characters omitted.]\n${"x".repeat(11_900)}`,
		],
	])("replays %s stored tool results with explicit truncation in transcript order", async (_name, text, expected) => {
		const manager = SessionManager.create(cwd);
		manager.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: "call-one", name: "file", arguments: {} }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-one",
			toolName: "file",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 2,
		});
		const saved = { id: manager.getSessionId(), path: manager.getSessionFile()! };
		const worker = new FakeWorker();
		worker.getState.mockResolvedValue({
			sessionId: saved.id,
			sessionFile: saved.path,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messageCount: 2,
			pendingMessageCount: 0,
		});
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		await h.connection.agent.request(methods.agent.session.load, { cwd, sessionId: saved.id, mcpServers: [] });
		expect(h.updates.map(({ update }) => update)).toMatchObject([
			{ sessionUpdate: "tool_call", toolCallId: "call-one", status: "in_progress" },
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-one",
				status: "completed",
				content: [{ content: { text: expected } }],
			},
		]);
	});

	it("paginates session discovery with a cwd-bound cursor", async () => {
		for (let index = 0; index < 51; index++) {
			const manager = SessionManager.create(cwd);
			manager.appendMessage({ role: "user", content: `question ${index}`, timestamp: index + 1 });
		}
		const h = harness();
		await h.initialize();
		const first = await h.connection.agent.request(methods.agent.session.list, { cwd });
		expect(first.sessions).toHaveLength(50);
		expect(first.nextCursor).toBeTruthy();
		const second = await h.connection.agent.request(methods.agent.session.list, { cwd, cursor: first.nextCursor });
		expect(second.sessions).toHaveLength(1);
		expect(second.nextCursor).toBeUndefined();
		await expect(
			h.connection.agent.request(methods.agent.session.list, {
				cwd: home,
				cursor: first.nextCursor,
			}),
		).rejects.toThrow("cursor");
	});

	it("reserves a durable ID during restoration and publishes it only when ready", async () => {
		const saved = transcript();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const worker = new FakeWorker();
		worker.start.mockImplementationOnce(async () => {
			await gate;
		});
		worker.getState.mockResolvedValue({
			sessionId: saved.id,
			sessionFile: saved.path,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messageCount: 2,
			pendingMessageCount: 0,
		});
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		const loading = h.connection.agent.request(methods.agent.session.load, {
			cwd,
			sessionId: saved.id,
			mcpServers: [],
		});
		await expect.poll(() => worker.start.mock.calls.length).toBe(1);
		await expect(h.prompt(saved.id)).rejects.toThrow();
		await expect(
			h.connection.agent.request(methods.agent.session.resume, {
				cwd,
				sessionId: saved.id,
				mcpServers: [],
			}),
		).rejects.toThrow("restoring");
		release();
		await expect(loading).resolves.toEqual({});
	});

	it("resolves a relative session directory against the requested workspace", async () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_SESSION_DIR", "relative-sessions");
		const manager = SessionManager.create(cwd, join(cwd, "relative-sessions"));
		manager.appendMessage({ role: "user", content: "workspace transcript", timestamp: 1 });
		const h = harness();
		await h.initialize();
		const listing = await h.connection.agent.request(methods.agent.session.list, { cwd });
		expect(listing.sessions).toMatchObject([{ sessionId: manager.getSessionId(), cwd }]);
	});

	it("fails closed when an empty transcript cannot be materialized", async () => {
		const manager = SessionManager.create(cwd);
		const path = manager.getSessionFile()!;
		await writeFile(path, "occupied");
		expect(() => manager.materialize()).toThrow();
		expect(() => manager.appendMessage({ role: "user", content: "unsafe retry", timestamp: 1 })).toThrow();
		expect(await readFile(path, "utf8")).toBe("occupied");
	});
});
