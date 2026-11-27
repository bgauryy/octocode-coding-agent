// A model switch carries the thinking level the user last asked for in the session, clamped to the new model;
// an explicit (scoped) level and a per-model setting still win, and the global default applies only before any request.
import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("thinking level on a model switch", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(settings = {}) {
		const harness = await createHarness({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: true },
				{ id: "plain", reasoning: false },
			],
			settings,
		});
		harnesses.push(harness);
		return harness;
	}
	const model = (harness: Harness, id: string) => harness.getModel(id)!;

	it("carries the requested level over the global default", async () => {
		const harness = await start({ defaultThinkingLevel: "medium" });
		harness.session.setThinkingLevel("low");

		await harness.session.setModel(model(harness, "two"));
		expect(harness.session.thinkingLevel).toBe("low");
		await harness.session.cycleModel("backward");
		expect(harness.session.model?.id).toBe("one");
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("uses the global default while the session has no requested level", async () => {
		const harness = await start({ defaultThinkingLevel: "minimal" });
		await harness.session.setModel(model(harness, "two"));
		expect(harness.session.thinkingLevel).toBe("minimal");
	});

	it("clamps through a model without reasoning and restores the requested level after it", async () => {
		const harness = await start({ defaultThinkingLevel: "medium" });
		harness.session.setThinkingLevel("high");

		await harness.session.setModel(model(harness, "plain"));
		expect(harness.session.thinkingLevel).toBe("off");
		await harness.session.setModel(model(harness, "two"));
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("keeps a level the model lacks as requested and sends it where supported", async () => {
		const harness = await start();
		harness.session.setThinkingLevel("max");
		expect(harness.session.thinkingLevel).toBe("high");

		model(harness, "two").thinkingLevelMap = { xhigh: "xhigh", max: "max" };
		await harness.session.setModel(model(harness, "two"));
		expect(harness.session.thinkingLevel).toBe("max");
	});

	it("lets a per-model setting win without replacing the requested level", async () => {
		const harness = await start({ modelThinkingLevels: { "faux/two": "minimal" } });
		harness.session.setThinkingLevel("high");

		await harness.session.setModel(model(harness, "two"));
		expect(harness.session.thinkingLevel).toBe("minimal");
		await harness.session.setModel(model(harness, "one"));
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("lets an explicit scoped level win without replacing the requested level", async () => {
		const harness = await start();
		const scoped: Array<{ model: Model<string>; thinkingLevel?: ThinkingLevel }> = [
			{ model: model(harness, "one") },
			{ model: model(harness, "two"), thinkingLevel: "minimal" },
		];
		harness.session.setScopedModels(scoped);
		harness.session.setThinkingLevel("medium");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("two");
		expect(harness.session.thinkingLevel).toBe("minimal");
		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("one");
		expect(harness.session.thinkingLevel).toBe("medium");
	});

	it("records no model change when the model and thinking level stay the same", async () => {
		const harness = await start();
		await harness.session.setModel(model(harness, "two"));
		const changes = () => harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change");
		const thinking = () =>
			harness.sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change");
		const before = { model: changes().length, thinking: thinking().length };

		await harness.session.setModel(model(harness, "two"));
		expect({ model: changes().length, thinking: thinking().length }).toEqual(before);
	});
});
