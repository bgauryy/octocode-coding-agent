import { join } from "node:path";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { clampThinkingLevel } from "@octocodeai/octocode-ai/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createSandbox, type Sandbox, write } from "./discovery/fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

/** Medium and minimal are unsupported; low and high have provider names. */
const thinkingLevelMap = { off: null, minimal: null, low: "lo", medium: null, high: "hi" };

async function gatewayModel() {
	write(
		join(sandbox.agentDir, "models.json"),
		JSON.stringify({
			providers: {
				gw: {
					baseUrl: "https://gw.example/v1",
					api: "openai-completions",
					apiKey: "k",
					defaults: { thinkingLevelMap },
					models: [{ id: "reasoner", reasoning: true }],
				},
			},
		}),
	);
	const config = await ModelConfig.load(join(sandbox.agentDir, "models.json"), {
		cwd: sandbox.cwd,
		isTrusted: () => true,
	});
	return composeModelProvider("gw", undefined, config, undefined).getModels()[0];
}

describe("a provider-level thinkingLevelMap from models.json", () => {
	it("reaches the model and clamps an unsupported level to the nearest lower one", async () => {
		const model = await gatewayModel();
		expect(model.thinkingLevelMap).toEqual(thinkingLevelMap);
		expect(clampThinkingLevel(model, "medium")).toBe("low");
		expect(clampThinkingLevel(model, "minimal")).toBe("low");
		expect(clampThinkingLevel(model, "high")).toBe("high");
	});

	it("puts the clamped level's provider value on the request", async () => {
		const model = await gatewayModel();
		const bodies: Array<Record<string, unknown>> = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('{"error":{"message":"fixture"}}', { status: 400 });
		};
		for (const reasoning of ["medium", "high"] as const)
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "k", fetch, maxRetries: 0, reasoning },
			).result();
		expect(bodies.map((body) => body.reasoning_effort)).toEqual(["lo", "hi"]);
	});
});
