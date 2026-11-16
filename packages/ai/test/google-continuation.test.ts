import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/** The SDK wire path does not expose the retired vendor client's automatic continuation configuration. */
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

function model<T extends "google-generative-ai" | "google-vertex">(api: T): Model<T> {
	return {
		id: "gemini-3.7-flash",
		name: "gemini-3.7-flash",
		api,
		provider: `test-${api}`,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

type Run = (options: SimpleStreamOptions) => ReturnType<typeof streamSimpleGoogle>;

async function capture(run: Run) {
	let payload: Record<string, unknown> | undefined;
	const result = await run({
		apiKey: "test",
		onPayload: (request) => {
			payload = request as Record<string, unknown>;
			throw new Error("payload captured");
		},
	}).result();
	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

describe("Google automatic continuation", () => {
	it("Gemini uses the SDK wire body, without native continuation configuration", async () => {
		const payload = await capture((options) => streamSimpleGoogle(model("google-generative-ai"), context, options));
		expect(payload).toHaveProperty("contents");
		expect(payload).not.toHaveProperty("config");
		expect(payload).not.toHaveProperty("continuationToken");
	});

	it.each<[string, Run]>([
		["Google Vertex", (options) => streamSimpleVertex(model("google-vertex"), context, options)],
	])("is off in the request %s sends", async (_name, run) => {
		const payload = await capture(run);
		expect(payload).toHaveProperty("contents");
		expect(payload).not.toHaveProperty("config");
		expect(payload).not.toHaveProperty("continuationToken");
	});
});
