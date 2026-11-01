import { expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { contextReport, renderContextReport } from "../src/core/agent-session/context-report.ts";
import { createHarness } from "./suite/harness.ts";

it("attributes each effective instruction and tool once, labels unknown usage and hides prompt text", async () => {
	const harness = await createHarness();
	try {
		const { session, sessionManager } = harness;
		const request = vi.spyOn(session.agent, "streamFunction");
		sessionManager.appendMessage({
			role: "system",
			content: "private base instructions",
			sections: { policy: "private policy" },
			toolsAdded: [{ name: "reader", description: "reads", parameters: { type: "object", properties: {} } }],
			timestamp: 1,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: '<skill name="test" location="/skills/test.md">\nprivate body\n</skill>\n\nUse this skill',
				},
			],
			timestamp: 2,
		});
		session.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 20_000 });
		const report = contextReport(session);
		expect(report.currentTokens).toBeNull();
		expect(report.reportedTokens).toBeNull();
		expect(report.difference).toBeNull();
		expect(report.contributors.map((row) => row.name)).toEqual([
			"System instructions",
			"Instruction section: policy",
			"Tool definition: reader",
			"Loaded skill instructions",
			"user messages",
		]);
		expect(report.estimatedTotal).toBe(report.contributors.reduce((sum, row) => sum + row.tokens, 0));
		expect(renderContextReport(report)).toContain("unknown");
		expect(renderContextReport(report)).not.toContain("private");
		expect(request).not.toHaveBeenCalled();
	} finally {
		harness.cleanup();
	}
});

it("uses the latest physical route's capacity and reserve in a virtual context report", async () => {
	const harness = await createHarness({ models: [{ id: "physical", contextWindow: 64_000 }] });
	try {
		const { session, getModel } = harness;
		harness.setResponses([fauxAssistantMessage("answer")]);
		await session.prompt("hello");
		session.modelRuntime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			contextWindow: 1000,
			route: () => ({ model: getModel(), thinkingLevel: "off" }),
		});
		await session.setModel(session.modelRuntime.getModel("router", "auto")!);
		const report = session.getContextReport();
		expect(report).toMatchObject({ capacity: 64_000, catalogCapacity: null, reserve: 10_666, threshold: 53_334 });
		expect(renderContextReport(report)).toContain("Select a physical model with /model");
		expect(() => session.setContextWindow(32_000)).toThrow("Select a physical model");
	} finally {
		harness.cleanup();
	}
});

it("compacts before dispatch using the routed model's output reserve", async () => {
	const harness = await createHarness({
		models: [{ id: "physical", contextWindow: 64_000 }],
		builtinCompactionFactories: [
			(extension) => {
				extension.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "Auto",
					contextWindow: 1000,
					route: (_request, ctx) => ({ model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" }),
				});
				extension.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
					compaction: { summary: "compacted history", firstKeptEntryId, tokensBefore },
				}));
			},
		],
	});
	try {
		const { session, sessionManager } = harness;
		await session.setModel(session.modelRuntime.getModel("router", "auto")!);
		sessionManager.appendMessage({ role: "user", content: "x".repeat(122_500), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("old answer"));
		sessionManager.appendMessage({ role: "user", content: "x".repeat(50_000), timestamp: 2 });
		const previous = fauxAssistantMessage("previous answer");
		previous.usage = { ...previous.usage, input: 57_500, output: 4, totalTokens: 57_504 };
		sessionManager.appendMessage(previous);
		let compactedBeforeDispatch = false;
		harness.setResponses([
			() => {
				compactedBeforeDispatch = harness.eventsOfType("compaction_end").some((event) => event.result);
				return fauxAssistantMessage("answer");
			},
		]);
		await session.prompt("next");
		expect(session.messages.at(-1)).not.toMatchObject({ role: "assistant", stopReason: "error" });
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(compactedBeforeDispatch).toBe(true);
	} finally {
		harness.cleanup();
	}
});

it("suggests /context all only while contributors are folded into 'Other contributors'", () => {
	const report = (count: number) =>
		({
			model: "m",
			at: "now",
			reportedTokens: null,
			currentTokens: 10,
			capacity: 1000,
			reserve: 1,
			threshold: 900,
			catalogCapacity: null,
			estimatedTotal: 10,
			difference: 0,
			note: "n",
			contributors: Array.from({ length: count }, (_, index) => ({ name: `part ${index}`, tokens: index + 1 })),
		}) as never;
	expect(renderContextReport(report(12))).toContain("Use /context all");
	expect(renderContextReport(report(12))).toContain("Other contributors");
	expect(renderContextReport(report(12), true)).not.toContain("Use /context all");
	expect(renderContextReport(report(3))).not.toContain("Use /context all");
	expect(renderContextReport(report(3))).toContain("/mcp exposure controls");
});

it("leads with the total in use, free space and distance to compaction, and totals the contributors", () => {
	const base = {
		model: "m",
		at: "now",
		reportedTokens: 50_000,
		capacity: 200_000,
		reserve: 25_000,
		threshold: 175_000,
		catalogCapacity: 200_000,
		difference: 0,
		note: "n",
		contributors: [
			{ name: "System instructions", tokens: 10_000 },
			{ name: "user messages", tokens: 40_000 },
		],
		estimatedTotal: 50_000,
	};
	const text = renderContextReport({ ...base, currentTokens: 50_000 });
	const [first] = text.split("\n\n");
	expect(first).toBe(
		[
			"**Total context: 50,000 of 200,000 tokens in use (25%)**",
			`\`${"█".repeat(8)}${"░".repeat(22)}\` 150,000 free`,
			"Compaction starts at 175,000 tokens, 125,000 from now.",
		].join("\n"),
	);
	expect(text).toContain("| user messages | 40,000 | 80% |");
	expect(text).toContain("| **Total** | **50,000** | 100% |");
	// Without a usage figure the contents estimate stands in, labelled; past the threshold it says compaction comes next.
	expect(renderContextReport({ ...base, currentTokens: null })).toContain("(estimated from the contents below)");
	expect(renderContextReport({ ...base, currentTokens: 180_000 })).toContain(
		"Past the compaction point (175,000 tokens): the next request compacts first.",
	);
});
