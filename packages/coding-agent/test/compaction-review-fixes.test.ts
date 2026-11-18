import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import {
	finalizeCompactionResult,
	generateBranchSummary,
	generateSummaryWithUsage,
	projectAfterCompaction,
} from "../src/core/compaction/index.ts";
import { renderPrompt } from "../src/core/prompt-template.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "m",
	name: "m",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function reply(stopReason: "stop" | "length", output: number): AssistantMessage {
	const base = fauxAssistantMessage("");
	return {
		...base,
		content: [{ type: "text", text: "## Goal\nx\n## Where it stopped\ny" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		usage: { ...base.usage, output, totalTokens: output, cost: { ...base.usage.cost, total: output / 100 } },
	};
}

function streamOf(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason as "stop" | "length", message }));
	return stream;
}

const userEntry = (id: string, parentId: string | null, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(1).toISOString(),
	message: { role: "user", content: text, timestamp: 1 },
});

describe("compaction review fixes", () => {
	it("reports the usage of every request when a cut-off summary is retried", async () => {
		const replies = [reply("length", 100), reply("length", 50), reply("stop", 25)];
		const streamFn: StreamFn = () => streamOf(replies.shift()!);
		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "work", timestamp: 1 }],
			model,
			undefined,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);
		expect(result.usage.output).toBe(175);
		expect(result.usage.cost.total).toBeCloseTo(1.75);
	});

	it("tells a branch summary request how many older entries did not fit", async () => {
		const entries = Array.from({ length: 6 }, (_, i) =>
			userEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, `${"word ".repeat(400)}${i}`),
		);
		let prompt = "";
		const streamFn: StreamFn = (_model, context) => {
			prompt = JSON.stringify(context.messages.filter((message) => message.role === "user"));
			return streamOf(reply("stop", 1));
		};
		const small = { ...model, contextWindow: 1500 };
		const result = await generateBranchSummary(entries, {
			model: small,
			signal: new AbortController().signal,
			reserveTokens: 0,
			streamFn,
		});
		expect(result.error).toBeUndefined();
		const shown = entries.filter(
			(e) => e.type === "message" && prompt.includes(JSON.stringify((e.message as any).content).slice(1, -1)),
		).length;
		const dropped = entries.length - shown;
		expect(dropped).toBeGreaterThan(0);
		expect(prompt).toContain(
			JSON.stringify(renderPrompt("workflows/compaction/dropped-messages.md", { dropped })).slice(1, -1).trim(),
		);
	});

	it("leaves no checkpoint file behind when the compaction cannot fit after saving one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-fit-"));
		try {
			const sessionFile = path.join(dir, "s.jsonl");
			const entries = [userEntry("a", null, "hello"), userEntry("b", "a", "world")];
			const reserve = 1000;
			const base = projectAfterCompaction(entries, "b")("");
			// Room for a few tokens only: the reference to a saved file cannot fit, so finalizing fails.
			const contextWindow = reserve + base + 5;
			expect(() =>
				finalizeCompactionResult(
					{ summary: "x".repeat(4000), firstKeptEntryId: "b", tokensBefore: 10 },
					{ branchEntries: entries, contextWindow, reserveTokens: reserve, sessionFile },
				),
			).toThrow(/cannot fit/);
			expect(fs.readdirSync(dir).filter((name) => name.includes(".checkpoint-"))).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
