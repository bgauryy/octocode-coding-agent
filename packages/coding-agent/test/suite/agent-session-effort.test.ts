import { fauxAssistantMessage, type SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The thinking level a session shows is the `reasoning` option its next request carries: a model without reasoning
 * sends none, a level the model lacks is clamped, and a model switch re-picks the level for the new model.
 */
describe("AgentSession effort reaches the request", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(settings = {}) {
		const harness = await createHarness({
			models: [
				{ id: "thinker", reasoning: true },
				{ id: "plain", reasoning: false },
			],
			settings,
		});
		harnesses.push(harness);
		return harness;
	}

	/** The `reasoning` option of every request the faux provider receives while `run` prompts. */
	async function requests(harness: Harness, run: () => Promise<void>, replies = 1) {
		const seen: Array<SimpleStreamOptions["reasoning"] | "none"> = [];
		harness.setResponses(
			Array.from({ length: replies }, () => (_context: unknown, options: SimpleStreamOptions | undefined) => {
				seen.push(options?.reasoning ?? "none");
				return fauxAssistantMessage("ok");
			}),
		);
		await run();
		return seen;
	}

	it("sends the configured level of a reasoning model", async () => {
		const harness = await start({ defaultThinkingLevel: "low" });
		await harness.session.setModel(harness.getModel("thinker")!);
		expect(harness.session.thinkingLevel).toBe("low");
		expect(await requests(harness, () => harness.session.prompt("go"))).toEqual(["low"]);
	});

	it("sends no reasoning for a model without it, whatever level is set", async () => {
		const harness = await start({ defaultThinkingLevel: "high" });
		await harness.session.setModel(harness.getModel("plain")!);
		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(await requests(harness, () => harness.session.prompt("go"))).toEqual(["none"]);
	});

	it("clamps a level the model lacks (xhigh on a model with the standard levels) before it is sent", async () => {
		const harness = await start();
		await harness.session.setModel(harness.getModel("thinker")!);
		harness.session.setThinkingLevel("xhigh");
		const shown = harness.session.thinkingLevel;
		expect(await requests(harness, () => harness.session.prompt("go"))).toEqual([shown]);
		expect(harness.session.getAvailableThinkingLevels()).toContain(shown);
	});

	it("re-picks the level when the model changes: a per-model level wins over the default", async () => {
		const harness = await start({ defaultThinkingLevel: "medium" });
		harness.settingsManager.setModelThinkingLevel(harness.getModel("thinker")!.provider, "thinker", "high");
		await harness.session.setModel(harness.getModel("plain")!);
		await harness.session.setModel(harness.getModel("thinker")!);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(await requests(harness, () => harness.session.prompt("go"))).toEqual(["high"]);
	});

	it("sends the level changed between two prompts on the second request only", async () => {
		const harness = await start({ defaultThinkingLevel: "low" });
		await harness.session.setModel(harness.getModel("thinker")!);
		const seen = await requests(
			harness,
			async () => {
				await harness.session.prompt("one");
				harness.session.setThinkingLevel("high");
				await harness.session.prompt("two");
			},
			2,
		);
		expect(seen).toEqual(["low", "high"]);
	});
});
