import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../coding-agent/src/core/session-manager.ts";
import { assistant, FakeWorker, harness } from "./acp-test-harness.ts";

let cwd: string;
let home: string;
beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "acp-reload-work-")));
	home = await mkdtemp(join(tmpdir(), "acp-reload-home-"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

function savedSession() {
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "remember me", timestamp: 1 });
	manager.appendMessage(assistant("remembered"));
	const workers: FakeWorker[] = [];
	const h = harness({
		createWorker: async () => {
			const worker = new FakeWorker();
			const state = await worker.getState();
			worker.getState.mockResolvedValue({
				...state,
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile(),
			});
			workers.push(worker);
			return worker;
		},
	});
	const params = { cwd, sessionId: manager.getSessionId(), mcpServers: [] };
	return { h, workers, params };
}

it("reloads an idle session on the same connection, replays before response, and uses current MCP definitions", async () => {
	const { h, workers, params } = savedSession();
	await h.initialize();
	await h.connection.agent.request(methods.agent.session.load, params);
	h.updates.length = 0;
	const mcpServers = [{ name: "current", command: process.execPath, args: [], env: [] }];
	await h.connection.agent.request(methods.agent.session.load, { ...params, mcpServers });
	expect(h.updates.map(({ update }) => update)).toMatchObject([
		{ sessionUpdate: "user_message_chunk", content: { text: "remember me" } },
		{ sessionUpdate: "agent_message_chunk", content: { text: "remembered" } },
	]);
	expect(workers[0].stop).toHaveBeenCalledOnce();
	expect(workers[1].stop).not.toHaveBeenCalled();
	expect(h.createWorker).toHaveBeenLastCalledWith(cwd, mcpServers, expect.any(String));
	h.updates.length = 0;
	await h.connection.agent.request(methods.agent.session.resume, params);
	expect(h.updates).toEqual([]);
	expect(workers[1].stop).toHaveBeenCalledOnce();
	const reply = h.prompt(params.sessionId);
	await expect.poll(() => workers[2].prompt.mock.calls.length).toBe(1);
	workers[2].finish("still usable");
	await expect(reply).resolves.toEqual({ stopReason: "end_turn" });
});

it("refuses restoration of busy work without stopping or replacing its worker", async () => {
	const { h, workers, params } = savedSession();
	await h.initialize();
	await h.connection.agent.request(methods.agent.session.resume, params);
	const reply = h.prompt(params.sessionId);
	await expect.poll(() => workers[0].prompt.mock.calls.length).toBe(1);
	await expect(h.connection.agent.request(methods.agent.session.load, params)).rejects.toThrow("busy");
	expect(workers[0].stop).not.toHaveBeenCalled();
	expect(workers).toHaveLength(1);
	workers[0].finish();
	await expect(reply).resolves.toEqual({ stopReason: "end_turn" });
});

it("validates the original workspace before releasing an existing session", async () => {
	const { h, workers, params } = savedSession();
	await h.initialize();
	await h.connection.agent.request(methods.agent.session.resume, params);
	await expect(h.connection.agent.request(methods.agent.session.load, { ...params, cwd: home })).rejects.toThrow();
	expect(workers[0].stop).not.toHaveBeenCalled();
	expect(workers).toHaveLength(1);
});
