import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { modelEntry, providerFor, wireBox } from "./provider-wire-box.ts";
import { type Family, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * A declared `profile` and `defaults.thinkingLevelMap` in models.json, seen on the request the real CLI sends: a gateway
 * that serves Claude gets Anthropic cache markers only when its profile says so, OpenRouter's profile changes the
 * reasoning field, and a level the map marks null is sent as the nearest lower one.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

async function send(family: Family, fields: Record<string, unknown>, args: string[] = [], id = "model") {
	wire = await startWire(family);
	const box = wireBox();
	box.writeModels({
		gw: providerFor(family, wire, {
			authHeader: family.startsWith("openai"),
			models: [{ ...modelEntry(id), reasoning: true }],
			...fields,
		}),
	});
	const run = box.start(["-p", "think", "--model", `gw/${id}`, ...args], { model: false });
	const { code } = await run.exited;
	expect(code, run.stderr()).toBe(0);
	expect(box.violations()).toEqual([]);
	return wire.seen[0];
}

const markerValues = (body: unknown) =>
	[...JSON.stringify(body).matchAll(/"cache_control":(\{[^}]*\})/g)].map((m) => m[1]);

describe("profile on an Anthropic-format gateway", () => {
	it("profile anthropic puts cache_control markers on the request, with the 1h tier on long retention", async () => {
		const request = await send("anthropic-messages", { profile: "anthropic" });
		expect(markerValues(request.body)).toEqual(Array(3).fill('{"type":"ephemeral"}'));
		const long = await send("anthropic-messages", { profile: "anthropic", cacheRetention: "long" });
		expect(markerValues(long.body)).toContain('{"type":"ephemeral","ttl":"1h"}');
	});

	// The anthropic-messages api alone already earns the 5-minute markers; the profile is what unlocks the 1h tier.
	it("without a profile, an unknown host still gets the 5-minute markers but never the 1h tier", async () => {
		const request = await send("anthropic-messages", {});
		expect(markerValues(request.body)).toEqual(Array(3).fill('{"type":"ephemeral"}'));
		const long = await send("anthropic-messages", { cacheRetention: "long" });
		expect(markerValues(long.body).filter((value) => value.includes("1h"))).toEqual([]);
	});
});

describe("profile openrouter on an openai-completions provider", () => {
	it("sends reasoning as OpenRouter's `reasoning.effort` object, not `reasoning_effort`", async () => {
		const request = await send("openai-completions", { profile: "openrouter" }, ["--thinking", "high"]);
		expect(request.body.reasoning).toEqual({ effort: "high" });
		expect(request.body.reasoning_effort).toBeUndefined();
	});

	it("without it, the plain OpenAI field", async () => {
		const request = await send("openai-completions", {}, ["--thinking", "high"]);
		expect(request.body.reasoning_effort).toBe("high");
		expect(request.body.reasoning).toBeUndefined();
	});
});

describe("defaults.thinkingLevelMap", () => {
	const effort = (body: any) => body.reasoning_effort;

	it("sends the mapped value of a level", async () => {
		const map = { low: "mapped-low", medium: "mapped-medium", high: "mapped-high" };
		const request = await send("openai-completions", { defaults: { thinkingLevelMap: map } }, ["--thinking", "high"]);
		expect(effort(request.body)).toBe("mapped-high");
	});

	it("sends the nearest lower mapped level for a level marked null", async () => {
		const map = { low: "mapped-low", medium: null, high: "mapped-high" };
		const request = await send("openai-completions", { defaults: { thinkingLevelMap: map } }, ["--thinking", "medium"]);
		expect(effort(request.body)).toBe("mapped-low");
	});

	it("sends no effort when every level is null", async () => {
		const none = { minimal: null, low: null, medium: null, high: null };
		const request = await send("openai-completions", { defaults: { thinkingLevelMap: none } }, [
			"--thinking",
			"medium",
		]);
		expect(request.body.reasoning_effort).toBeUndefined();
		expect(request.body.reasoning).toBeUndefined();
	});
});

describe("an unknown Google model id", () => {
	it.each(["low", "high"])("asks for dynamic thinking (thinkingBudget -1) at level %s", async (level) => {
		const request = await send("google-generative-ai", {}, ["--thinking", level], "gemini-custom-x");
		expect(request.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1, includeThoughts: true });
	});
});
