import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * `yarn vitest run` inside an Octocode subagent exports `OCTOCODE_INSTRUCTION_CACHE_RETENTION=long`; before the shared
 * setup file cleared it, the default-marker tests of the Anthropic adapter failed there with `ttl: "1h"` on a request
 * that asked for nothing.
 */
describe("cache test environment", () => {
	it("starts without cache retention variables", () => {
		expect(process.env.OCTOCODE_CACHE_RETENTION).toBeUndefined();
		expect(process.env.OCTOCODE_INSTRUCTION_CACHE_RETENTION).toBeUndefined();
		expect(process.env.OCTOCODE_INSTRUCTION_CACHE_SPLIT).toBeUndefined();
	});

	it("sends the default 5-minute marker when the request does not name a retention", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		let system: { cache_control?: unknown }[] | undefined;
		await anthropicStream(
			model,
			normalizeContext({ systemPrompt: "Stable", messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{
				apiKey: "sk-ant-api-test",
				onPayload: (value) => {
					system = (value as { system: typeof system }).system;
					throw new Error("captured");
				},
			},
		).result();
		expect(system?.[0].cache_control).toEqual({ type: "ephemeral" });
	});
});
