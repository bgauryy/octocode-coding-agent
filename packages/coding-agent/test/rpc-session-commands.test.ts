/**
 * RPC session commands against a real session on the faux provider: state, persistence, compaction, user bash,
 * thinking levels, models, stats, new session, HTML export, last assistant text, entries, tree and session name.
 * Commands go through `handleCommand`, the dispatcher RPC mode feeds each JSONL line to.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseStep } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { handleCommand, type RpcCommandHost } from "../src/modes/rpc/rpc-mode/commands.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type Rpc = {
	harness: Harness;
	runtime: AgentSessionRuntime;
	tempDir: string;
	send: (command: RpcCommand) => Promise<Record<string, any>>;
	promptAndWait: (message: string, reply?: FauxResponseStep) => Promise<void>;
	sessionEntries: () => Array<Record<string, any>>;
};

describe("RPC session commands", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRpc(compactionPolicy?: { keepRecentTokens: number }): Promise<Rpc> {
		const tempDir = join(tmpdir(), `octocode-rpc-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const harness = await createHarness({
			models: [{ id: "faux-reasoning", reasoning: true }],
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			cwd: tempDir,
			compactionPolicy,
		});
		const services: AgentSessionServices = {
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		const runtime = new AgentSessionRuntime(harness.session, services, factory);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) await runtime.dispose();
			harness.cleanup();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		const outputs: unknown[] = [];
		const waiters: Array<() => void> = [];
		const host: RpcCommandHost = {
			get session() {
				return runtime.session;
			},
			runtimeHost: runtime,
			output: (value) => {
				outputs.push(value);
				for (const wake of waiters.splice(0)) wake();
			},
		};
		let nextId = 0;
		const send = async (command: RpcCommand) => {
			const response = await handleCommand(host, command);
			if (!response) throw new Error(`No response to ${command.type}`);
			if (!response.success) throw new Error(response.error);
			return response as Record<string, any>;
		};
		const promptAndWait = async (message: string, reply: FauxResponseStep = fauxAssistantMessage("ok")) => {
			harness.appendResponses([reply]);
			const id = `prompt-${++nextId}`;
			await handleCommand(host, { id, type: "prompt", message, waitForCompletion: true });
			const answered = () => outputs.find((value) => (value as { id?: string }).id === id) as RpcResponse | undefined;
			while (!answered()) await new Promise<void>((resolve) => waiters.push(resolve));
			const response = answered()!;
			if (!response.success) throw new Error(response.error);
		};
		const sessionEntries = () =>
			readFileSync(runtime.session.sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		return { harness, runtime, tempDir, send, promptAndWait, sessionEntries };
	}

	it("reports the model and an idle, empty session in get_state", async () => {
		const { harness, send } = await createRpc();

		const { data: state } = await send({ type: "get_state" });

		expect(state.model).toMatchObject({ provider: harness.getModel().provider, id: harness.getModel().id });
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(harness.session.messages.filter((m) => m.role === "system").length);
	});

	it("saves the prompt and the reply to the session file", async () => {
		const { promptAndWait, sessionEntries } = await createRpc();

		await promptAndWait("Reply with just the word 'hello'", fauxAssistantMessage("hello"));

		const entries = sessionEntries();
		expect(entries[0].type).toBe("session");
		const roles = entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	});

	it("compacts manually and records one compaction entry, keeping the earlier entries", async () => {
		// Keep no recent history, so the one exchange is compacted.
		const { harness, send, promptAndWait, sessionEntries } = await createRpc({ keepRecentTokens: 1 });
		await promptAndWait("Say hello");
		const { data: before } = await send({ type: "get_entries" });

		harness.appendResponses([fauxAssistantMessage("Summary of the conversation.")]);
		const { data: result } = await send({ type: "compact" });

		expect(result.summary).toBeTruthy();
		expect(result.tokensBefore).toBeGreaterThan(0);
		const compactions = sessionEntries().filter((entry) => entry.type === "compaction");
		expect(compactions.length).toBe(1);
		expect(compactions[0].summary).toBeTruthy();
		// Append-only: the entries before compaction stay, in the same order.
		const { data: after } = await send({ type: "get_entries" });
		expect(after.entries.slice(0, before.entries.length).map((e: { id: string }) => e.id)).toEqual(
			before.entries.map((e: { id: string }) => e.id),
		);
		expect(after.entries.some((e: { type: string }) => e.type === "compaction")).toBe(true);
	});

	it("runs a bash command and returns its output", async () => {
		const { send } = await createRpc();

		const { data: result } = await send({ type: "bash", command: "echo hello" });

		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	});

	it("records bash output in the session and sends it to the model on the next prompt", async () => {
		const { send, promptAndWait, sessionEntries } = await createRpc();
		await promptAndWait("Say hi");
		const uniqueValue = `unique-${Date.now()}`;

		await send({ type: "bash", command: `echo ${uniqueValue}` });

		const bashMessages = sessionEntries().filter(
			(entry) => entry.type === "message" && entry.message.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);

		let request = "";
		await promptAndWait("What was the output of the echo command?", (context) => {
			request = JSON.stringify(context.messages);
			return fauxAssistantMessage(uniqueValue);
		});
		expect(request).toContain(uniqueValue);
	});

	it("sets, cycles and lists thinking levels consistently", async () => {
		const { send } = await createRpc();

		await send({ type: "set_thinking_level", level: "high" });
		expect((await send({ type: "get_state" })).data.thinkingLevel).toBe("high");

		const { data: levelsData } = await send({ type: "get_available_thinking_levels" });
		const levels: string[] = levelsData.levels;
		expect(levels.length).toBeGreaterThan(1);
		const initial = (await send({ type: "get_state" })).data.thinkingLevel;
		expect(levels).toContain(initial);

		const { data: cycled } = await send({ type: "cycle_thinking_level" });
		expect(cycled.level).not.toBe(initial);
		expect(levels).toContain(cycled.level);
		expect((await send({ type: "get_state" })).data.thinkingLevel).toBe(cycled.level);
	});

	it("lists available models with their required fields", async () => {
		const { send } = await createRpc();

		const { data } = await send({ type: "get_available_models" });

		expect(data.models.length).toBeGreaterThan(0);
		for (const model of data.models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	});

	it("reports session stats after a prompt", async () => {
		const { send, promptAndWait } = await createRpc();
		await promptAndWait("Hello");

		const { data: stats } = await send({ type: "get_session_stats" });

		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	});

	it("starts a new session that has no turns", async () => {
		const { send, promptAndWait, runtime } = await createRpc();
		await promptAndWait("Hello");
		const countBefore = (await send({ type: "get_state" })).data.messageCount;

		await send({ type: "new_session" });

		const countAfter = (await send({ type: "get_state" })).data.messageCount;
		expect(countAfter).toBeLessThan(countBefore);
		expect(runtime.session.messages.filter((message) => message.role !== "system")).toEqual([]);
	});

	it("exports the session to an HTML file", async () => {
		const { send, promptAndWait, tempDir } = await createRpc();
		await promptAndWait("Hello");

		const { data } = await send({ type: "export_html", outputPath: join(tempDir, "export.html") });

		expect(data.path.endsWith(".html")).toBe(true);
		expect(existsSync(data.path)).toBe(true);
	});

	it("returns the last assistant text, undefined before any reply", async () => {
		const { send, promptAndWait } = await createRpc();

		expect((await send({ type: "get_last_assistant_text" })).data.text).toBeUndefined();
		await promptAndWait("Reply with just: test123", fauxAssistantMessage("test123"));

		expect((await send({ type: "get_last_assistant_text" })).data.text).toContain("test123");
	});

	it("returns entries after a since cursor and refuses an unknown cursor", async () => {
		const { send, promptAndWait } = await createRpc();
		await promptAndWait("Reply with just 'ok'");

		const { data } = await send({ type: "get_entries" });
		expect(data.entries.length).toBeGreaterThanOrEqual(2);
		for (const entry of data.entries) expect(entry.id).toBeDefined();
		expect(data.leafId).toBe(data.entries.at(-1).id);

		const since = (await send({ type: "get_entries", since: data.entries[0].id })).data;
		expect(since.entries.map((e: { id: string }) => e.id)).toEqual(
			data.entries.slice(1).map((e: { id: string }) => e.id),
		);
		expect(since.leafId).toBe(data.leafId);

		await expect(send({ type: "get_entries", since: "nonexistent-id" })).rejects.toThrow("Entry not found");
	});

	it("returns a single-chain tree that matches the entries", async () => {
		const { send, promptAndWait } = await createRpc();
		await promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = (await send({ type: "get_entries" })).data;
		const { tree, leafId: treeLeafId } = (await send({ type: "get_tree" })).data;

		expect(treeLeafId).toBe(leafId);
		expect(tree.length).toBe(1);
		const chainIds: string[] = [];
		let nodes = tree;
		while (nodes.length === 1) {
			chainIds.push(nodes[0].entry.id);
			nodes = nodes[0].children;
		}
		expect(nodes.length).toBe(0);
		expect(chainIds).toEqual(entries.map((e: { id: string }) => e.id));
	});

	it("sets the session name and records it in the session file", async () => {
		const { send, promptAndWait, sessionEntries } = await createRpc();
		expect((await send({ type: "get_state" })).data.sessionName).toBeUndefined();
		await promptAndWait("Reply with just 'ok'");

		await send({ type: "set_session_name", name: "my-test-session" });

		expect((await send({ type: "get_state" })).data.sessionName).toBe("my-test-session");
		const infos = sessionEntries().filter((entry) => entry.type === "session_info");
		expect(infos.length).toBe(1);
		expect(infos[0].name).toBe("my-test-session");
	});
});
