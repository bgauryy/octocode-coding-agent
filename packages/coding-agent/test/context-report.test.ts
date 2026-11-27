import { expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { contextReport, renderContextReport } from "../src/core/agent-session/context-report.ts";
import { prepareCompaction, shouldCompact } from "../src/core/compaction/compaction.ts";
import { skillListingBudgetChars } from "../src/core/skills/listing-budget.ts";
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

it("groups declared tools by owner and warns when one MCP server's declarations pass their share", async () => {
	const harness = await createHarness();
	try {
		const { session, sessionManager } = harness;
		// A 50,000-token window: one server may declare five times the 1% instructions budget.
		const budget = skillListingBudgetChars(50_000) * 5;
		const schema = (size: number) => ({
			type: "object",
			properties: { q: { type: "string", description: "x".repeat(size) } },
		});
		sessionManager.appendMessage({
			role: "system",
			content: "base",
			sections: {},
			toolsAdded: [
				{ name: "bash", description: "runs", parameters: schema(10) },
				{ name: "mcp__big__search", description: "searches", parameters: schema(budget / 2) },
				{ name: "mcp__big__fetch", description: "fetches", parameters: schema(budget / 2) },
				{ name: "mcp__small__ping", description: "pings", parameters: schema(10) },
			],
			timestamp: 1,
		});
		session.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 50_000 });
		const report = contextReport(session);
		expect(report.declaredTools?.map(({ owner, tools }) => [owner, tools])).toEqual([
			["native", 1],
			["big", 2],
			["small", 1],
		]);
		expect(report.warnings).toEqual([
			expect.stringMatching(new RegExp(`^MCP server big tool declarations too long: \\d+ chars, budget ${budget} `)),
		]);
		const text = renderContextReport(report);
		expect(text).toMatch(/Declared tools: 4 \([\d,]+ tokens\): native 1 \([\d,]+\), big 2 \([\d,]+\), small 1/);
		expect(text).toContain("Warning: MCP server big tool declarations too long");
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
		expect(session.getContextUsage()?.compactionThreshold).toBe(report.threshold);
		expect(JSON.parse(JSON.stringify(session.getSessionStats())).contextUsage.compactionThreshold).toBe(
			report.threshold,
		);
		expect(renderContextReport(report)).toContain("Select a physical model with /model");
		expect(() => session.setContextWindow(32_000)).toThrow("Select a physical model");
	} finally {
		harness.cleanup();
	}
});

it("exports the physical route's thinking reserve without using the selected model's budget", async () => {
	const harness = await createHarness({ models: [{ id: "physical", contextWindow: 120_000, reasoning: true }] });
	try {
		const { session, getModel } = harness;
		session.setThinkingLevel("high");
		const reply = fauxAssistantMessage("answer");
		harness.setResponses([reply]);
		await session.prompt("hello");
		session.modelRuntime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			contextWindow: 120_000,
			route: () => ({ model: getModel(), thinkingLevel: "high" }),
		});
		await session.setModel(session.modelRuntime.getModel("router", "auto")!);
		session.setThinkingLevel("off");
		expect(session.getContextReport()).toMatchObject({ reserve: 20_000, threshold: 100_000 });
		expect(session.getContextUsage()).toMatchObject({ contextWindow: 120_000, compactionThreshold: 100_000 });
	} finally {
		harness.cleanup();
	}
});

it("compacts before dispatch using the routed model's output reserve", async () => {
	const harness = await createHarness({
		models: [{ id: "physical", contextWindow: 64_000 }],
		builtinCompactionFactories: [
			(feature) => {
				feature.bus.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
					compaction: { summary: "compacted history", firstKeptEntryId, tokensBefore },
				}));
			},
		],
	});
	harness.session.modelRuntime.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto",
		contextWindow: 1000,
		route: () => ({ model: harness.session.modelRuntime.getModel("faux", "physical")!, thinkingLevel: "off" }),
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

it("does not promise compaction when an oversized context has no summarizable history", async () => {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
		compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 500 },
	});
	try {
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(12_000), timestamp: 1 });
		const settings = harness.settingsManager.getCompactionSettings();
		expect(prepareCompaction(harness.sessionManager.getBranch(), settings)).toBeUndefined();
		const report = harness.session.getContextReport();
		expect(report.currentTokens ?? report.estimatedTotal).toBeGreaterThan(report.threshold!);
		expect(renderContextReport(report)).toContain("may compact eligible history first");
		expect(renderContextReport(report)).not.toContain("the next request compacts first");
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
			warnings: [],
			contributors: Array.from({ length: count }, (_, index) => ({ name: `part ${index}`, tokens: index + 1 })),
		}) as never;
	expect(renderContextReport(report(12))).toContain("Use /context all");
	expect(renderContextReport(report(12))).toContain("Other contributors");
	expect(renderContextReport(report(12), true)).not.toContain("Use /context all");
	expect(renderContextReport(report(3))).not.toContain("Use /context all");
	expect(renderContextReport(report(3))).toContain("/mcp exposure controls");
	const text = renderContextReport(report(3));
	expect(text).toContain("**Last request**");
	expect(text).toContain("**Current context estimate**");
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
		warnings: [],
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
			"Automatic compaction is eligible above 175,000 tokens, 125,000 from now.",
		].join("\n"),
	);
	expect(text).toContain("| user messages | 40,000 | 80% |");
	expect(text).toContain("| **Total** | **50,000** | 100% |");
	// Without a usage figure the contents estimate stands in, labelled; crossing the threshold does not guarantee a cut.
	expect(renderContextReport({ ...base, currentTokens: null })).toContain("(estimated from the contents below)");
	const settings = { enabled: true, reserveTokens: 25_000, keepRecentTokens: 1000 };
	expect(shouldCompact(175_000, base.capacity, settings)).toBe(false);
	expect(renderContextReport({ ...base, currentTokens: 175_000 })).toContain(
		"Automatic compaction is eligible above 175,000 tokens, 0 from now.",
	);
	expect(renderContextReport({ ...base, currentTokens: 180_000 })).toContain(
		"Above the compaction threshold (175,000 tokens): the next request may compact eligible history first.",
	);
});

it("warns when one MCP server's instructions or the context files pass 1% of the window, and cuts nothing", async () => {
	const harness = await createHarness();
	try {
		const { session, sessionManager } = harness;
		// A 20,000-token window: 1% of it, in characters at the default ratio.
		const budget = skillListingBudgetChars(20_000);
		const block = (name: string, body: string) => `<mcp name="${name}" tools="mcp__${name}__*">\n${body}\n</mcp>`;
		const long = "i".repeat(budget + 100);
		const typed = `/** ${long} */\ndeclare namespace typed {\n/** ${"d".repeat(5_000)} */\nfunction t(): void;\n}`;
		const mcps = [
			"Each block is one MCP server's instructions.",
			block("big", "b".repeat(budget + 1)),
			block("fits", "f".repeat(budget)),
			// A block with typed functions counts its instructions only.
			block("typed", typed),
			block("typed-small", typed.replace(long, "short")),
		].join("\n");
		const projectContext = "c".repeat(budget + 400);
		sessionManager.appendMessage({
			role: "system",
			content: "base",
			sections: { mcps, project_context: projectContext, policy: "p".repeat(5_000) },
			timestamp: 1,
		});
		session.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 20_000 });
		const report = contextReport(session);
		expect(report.warnings).toEqual([
			`MCP server typed instructions too long: ${budget + 100} chars, budget ${budget} · fix: disable the server in /mcp, or ask its maintainer to shorten its instructions`,
			`MCP server big instructions too long: ${budget + 1} chars, budget ${budget} · fix: disable the server in /mcp, or ask its maintainer to shorten its instructions`,
			`Context files too long: ${budget + 400} chars, budget ${budget} · move rarely needed rules into linked files`,
		]);
		const text = renderContextReport(report);
		expect(text.split("\n\n")[1]).toBe(report.warnings.map((warning) => `Warning: ${warning}`).join("\n"));
		// The report only measures: the sections are counted whole, as before.
		expect(report.contributors.find((row) => row.name === "Instruction section: mcps")?.tokens).toBeGreaterThan(1_500);

		session.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 200_000 });
		const roomy = contextReport(session);
		expect(roomy.warnings).toEqual([]);
		expect(renderContextReport(roomy)).not.toContain("Warning:");
	} finally {
		harness.cleanup();
	}
});
