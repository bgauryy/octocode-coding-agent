import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../coding-agent/src/core/session-manager.ts";
import { writtenSummary } from "../../../coding-agent/test/octocode/fixtures/compaction-summary.ts";
import { FakeWorker, harness } from "./acp-test-harness.ts";

type Update = SessionNotification["update"];

function toolText(update: Update): string {
	if (update.sessionUpdate !== "tool_call_update") return "";
	const block = update.content?.[0];
	return block?.type === "content" && block.content.type === "text" ? block.content.text : "";
}

describe("ACP compaction", () => {
	async function turn(events: Parameters<FakeWorker["emit"]>[0][]) {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const done = h.prompt(sessionId, "work");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		for (const event of events) worker.emit(event);
		worker.finish("after");
		await expect(done).resolves.toMatchObject({ stopReason: "end_turn" });
		return h.updates.map(({ update }) => update);
	}

	it("shows a running compaction and the summary a person reads when it succeeds", async () => {
		const updates = await turn([
			{ type: "compaction_start", reason: "threshold" },
			{
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				result: { summary: writtenSummary(), tokensBefore: 8000 },
			},
		]);
		const call = updates.find((update) => update.sessionUpdate === "tool_call");
		expect(call).toMatchObject({ title: "Compacting context (automatic)", kind: "other", status: "in_progress" });
		const end = updates.find((update) => update.sessionUpdate === "tool_call_update");
		expect(end).toMatchObject({ toolCallId: call!.toolCallId, status: "completed" });
		const text = toolText(end!);
		expect(text).toContain("Compacted 8,000 tokens");
		expect(text).toContain("## Goal\nFix the login bug");
		expect(text).not.toContain("<user-message>");
		expect(text).not.toContain("## Recovery");
	});

	it("reports a failed compaction with its message instead of ending silently", async () => {
		const updates = await turn([
			{ type: "compaction_start", reason: "manual" },
			{
				type: "compaction_end",
				reason: "manual",
				aborted: false,
				result: undefined,
				errorMessage: "Auto-compaction failed: model refused",
			},
		]);
		const end = updates.find((update) => update.sessionUpdate === "tool_call_update");
		expect(end).toMatchObject({ status: "failed" });
		expect(toolText(end!)).toBe("Auto-compaction failed: model refused");
	});

	it("reports a cancelled compaction as failed, and one that never started as a started then failed call", async () => {
		const aborted = await turn([
			{ type: "compaction_start", reason: "manual" },
			{ type: "compaction_end", reason: "manual", aborted: true, result: undefined },
		]);
		expect(toolText(aborted.find((update) => update.sessionUpdate === "tool_call_update")!)).toBe(
			"Compaction cancelled.",
		);
		const unstarted = await turn([
			{
				type: "compaction_end",
				reason: "overflow",
				aborted: false,
				result: undefined,
				errorMessage: "Context overflow recovery failed: no model is selected.",
			},
		]);
		expect(unstarted.map((update) => update.sessionUpdate)).toEqual([
			"tool_call",
			"tool_call_update",
			"agent_message_chunk",
		]);
		expect(unstarted[0]).toMatchObject({ title: "Compacting context (the context overflowed)" });
		expect(unstarted[1]).toMatchObject({ status: "failed" });
	});

	describe("history", () => {
		let cwd: string;
		let home: string;
		beforeEach(async () => {
			cwd = await realpath(await mkdtemp(join(tmpdir(), "acp-compaction-work-")));
			home = await mkdtemp(join(tmpdir(), "acp-compaction-home-"));
			vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", home);
		});
		afterEach(async () => {
			vi.unstubAllEnvs();
			await rm(cwd, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		});

		it("replays a compaction as the summary a person reads, not the raw summary", async () => {
			const manager = SessionManager.create(cwd);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
			const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: "kept" }], timestamp: 2 });
			manager.appendCompaction(writtenSummary(), kept, 9000);
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
			const updates = h.updates.map(({ update }) => update);
			const end = updates.find((update) => update.sessionUpdate === "tool_call_update");
			expect(updates.find((update) => update.sessionUpdate === "tool_call")).toMatchObject({
				title: "Context compacted",
				status: "completed",
			});
			expect(toolText(end!)).toContain("Compacted 9,000 tokens");
			expect(JSON.stringify(updates)).not.toContain("<user-message>");
			expect(JSON.stringify(updates)).not.toContain("## Recovery");
		});
	});
});
