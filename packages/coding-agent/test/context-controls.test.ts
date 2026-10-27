import { afterEach, describe, expect, it, vi } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import { handleContextSize, parseContextSize } from "../src/modes/interactive/interactive-mode/context-controls.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

const harnesses: Harness[] = [];
async function harness(options: HarnessOptions = {}) {
	const result = await createHarness({
		models: [
			{ id: "large", name: "Large", contextWindow: 200_000, maxTokens: 16_384 },
			{ id: "small", name: "Small", contextWindow: 64_000, maxTokens: 8192 },
		],
		...options,
	});
	harnesses.push(result);
	return result;
}
afterEach(() => {
	for (const item of harnesses.splice(0)) item.cleanup();
});

describe("session context controls", () => {
	it.each([
		["32k", 32000],
		["128000", 128000],
		["1M", 1000000],
		["0.5m", 500000],
	] as const)("parses %s", (value, tokens) => {
		expect(parseContextSize(value)).toBe(tokens);
	});
	it.each(["NaN", "Infinity", "0", "-1", "1.5", "32kb", "32k extra"])("rejects invalid context value %s", (value) => {
		expect(parseContextSize(value)).toBeUndefined();
	});
	it("uses the chosen budget for request preparation, usage and compaction without mutating catalog metadata", async () => {
		const { session, getModel } = await harness();
		const port = getApplicationPort(session);
		expect(port.invoke("setContextWindow", 32_000)).toBe(32_000);
		expect(session.model?.contextWindow).toBe(32_000);
		expect(session.getContextWindowLimit()).toBe(200_000);
		expect(getModel("large")?.contextWindow).toBe(200_000);
		const report = session.getContextReport();
		expect(report.capacity).toBe(32_000);
		expect(report.catalogCapacity).toBe(200_000);
		// A sixth of the window: on a window this small the answer and safety room (12,288 tokens, before any thinking
		// budget) already exceed window / 8, so the reserve is capped at window / 6.
		expect(report.reserve).toBe(5333);
		expect(report.threshold).toBe(26_667);
		const prepared = await session.agent.prepareRequest?.({
			model: session.model!,
			thinkingLevel: session.thinkingLevel,
			context: { messages: [], tools: [] },
		});
		expect(prepared?.model?.contextWindow).toBe(32_000);
	});
	it("remembers independent budgets across model switches and restores full capacity on reset", async () => {
		const { session, getModel } = await harness();
		session.setContextWindow(32_000);
		await session.setModel(getModel("small")!);
		expect(session.model?.contextWindow).toBe(64_000);
		session.setContextWindow(16_000);
		await session.setModel(getModel("large")!);
		expect(session.model?.contextWindow).toBe(32_000);
		expect(session.setContextWindow()).toBe(200_000);
		expect(getModel("large")?.contextWindow).toBe(200_000);
	});
	it.each(["set", "cycle", "scoped"] as const)(
		"reports the effective context budget after %s model selection",
		async (method) => {
			const selectedCapacities: number[] = [];
			const { session, getModel } = await harness({
				extensionFactories: [
					(extension) => {
						extension.on("model_select", (event) => {
							selectedCapacities.push(event.model.contextWindow);
						});
					},
				],
			});
			session.setContextWindow(32_000);
			await session.setModel(getModel("small")!);
			if (method === "scoped") {
				session.setScopedModels([{ model: getModel("large")! }, { model: getModel("small")! }]);
			}
			if (method === "set") await session.setModel(getModel("large")!);
			else expect((await session.cycleModel())?.model.contextWindow).toBe(32_000);
			expect(session.model?.contextWindow).toBe(32_000);
			expect(selectedCapacities).toEqual([64_000, 32_000]);
			expect(getModel("large")?.contextWindow).toBe(200_000);
		},
	);
	it("rejects unsupported sizes without changing the model", async () => {
		const { session } = await harness();
		for (const tokens of [0, 8191, 200001, Infinity, NaN, 32.5]) {
			expect(() => session.setContextWindow(tokens)).toThrow("Context size must be between");
		}
		expect(session.model?.contextWindow).toBe(200_000);
	});
	it("does not change context capacity while the coordinator is active", async () => {
		const { session } = await harness();
		vi.spyOn(session, "isIdle", "get").mockReturnValue(false);
		expect(() => session.setContextWindow(32_000)).toThrow("current request to finish");
		expect(session.model?.contextWindow).toBe(200_000);
	});
	it("supports a cancellable size picker, numeric CLI input and reset through the application port", async () => {
		const { session } = await harness();
		const select = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("32,000 tokens");
		const status = vi.fn();
		const host = createFakeHost({
			session,
			showExtensionSelector: select,
			showStatus: status,
			ui: { requestRender: vi.fn() },
		});
		expect(await handleContextSize(host, "")).toBe(false);
		expect(await handleContextSize(host, "all")).toBe(false);
		await handleContextSize(host, "size");
		expect(session.model?.contextWindow).toBe(200_000);
		await handleContextSize(host, "size");
		expect(session.model?.contextWindow).toBe(32_000);
		await handleContextSize(host, "64k");
		expect(session.model?.contextWindow).toBe(64_000);
		await handleContextSize(host, "reset");
		expect(session.model?.contextWindow).toBe(200_000);
		expect(status).toHaveBeenCalledTimes(3);
	});
	it.each(["model", "session", "host"] as const)("refuses a stale picker after the %s changes", async (change) => {
		const { session, getModel } = await harness();
		const replacement = change === "host" ? await harness() : undefined;
		const status = vi.fn();
		const host = createFakeHost({
			session,
			showExtensionSelector: async () => {
				if (change === "model") await session.setModel(getModel("small")!);
				else if (change === "session") session.sessionManager.newSession();
				else host.session = replacement!.session;
				return "32,000 tokens";
			},
			showStatus: status,
			ui: { requestRender: vi.fn() },
		});
		await expect(handleContextSize(host, "size")).rejects.toThrow("Model or session changed");
		expect(host.session.model?.contextWindow).toBe(change === "model" ? 64_000 : 200_000);
		expect(status).not.toHaveBeenCalled();
	});
});
