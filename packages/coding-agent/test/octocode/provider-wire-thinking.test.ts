import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { modelEntry, providerFor, wireBox } from "./provider-wire-box.ts";
import { type Family, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * `--thinking <level>` on a custom reasoning model, read from the request the real CLI sends: each family's own field.
 * Level clamping and the profile table are owned elsewhere; this pins that the chosen level reaches the wire.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

async function sendAt(family: Family, level: string, id = "model") {
	wire = await startWire(family);
	const box = wireBox();
	box.writeModels({
		gw: providerFor(family, wire, {
			authHeader: family.startsWith("openai"),
			models: [{ ...modelEntry(id), reasoning: true }],
		}),
	});
	const run = box.start(["-p", "think", "--model", `gw/${id}`, "--thinking", level], { model: false });
	const { code } = await run.exited;
	expect(code, run.stderr()).toBe(0);
	expect(box.violations()).toEqual([]);
	const body = wire.seen[0].body;
	await wire.close();
	return body;
}

// High asks for more than low: each budget is read from the wire at its own level.
const ANTHROPIC_BUDGET = { low: 2048, high: 6976 } as const;
const GOOGLE_25_BUDGET = { low: 2048, high: 24576 } as const;

describe.each(["low", "high"] as const)("--thinking %s", (level) => {
	it("openai-completions: reasoning_effort", async () => {
		expect((await sendAt("openai-completions", level)).reasoning_effort).toBe(level);
	});

	it("openai-responses: reasoning.effort", async () => {
		expect((await sendAt("openai-responses", level)).reasoning?.effort).toBe(level);
	});

	it("anthropic-messages: an enabled thinking block with this level's budget", async () => {
		const { thinking } = await sendAt("anthropic-messages", level);
		expect(thinking).toMatchObject({ type: "enabled", budget_tokens: ANTHROPIC_BUDGET[level] });
	});

	it("google 2.5 model: thinkingConfig.thinkingBudget of this level", async () => {
		const body = await sendAt("google-generative-ai", level, "gemini-2.5-flash");
		expect(body.generationConfig.thinkingConfig).toEqual({
			thinkingBudget: GOOGLE_25_BUDGET[level],
			includeThoughts: true,
		});
	});

	it("google 3 model: thinkingConfig.thinkingLevel is the level", async () => {
		const body = await sendAt("google-generative-ai", level, "gemini-3-flash-preview");
		expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: level });
	});
});

describe("--thinking off", () => {
	it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
		"%s sends no reasoning request",
		async (family) => {
			const body = await sendAt(family, "off");
			expect(body.reasoning_effort).toBeUndefined();
			// The Responses API turns reasoning off with an explicit `none`, which is not a level.
			expect([undefined, "none"]).toContain(body.reasoning?.effort);
			expect(body.thinking === undefined || body.thinking.type === "disabled").toBe(true);
		},
	);
});
