import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/google-vertex.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/compat.ts";
import { completionsResponse } from "./completions-fetch-fixture.ts";

describe("Vertex SDK continuation", () => {
	it("does not follow a continuation token with another billed request", async () => {
		const fetch = vi.fn(async () =>
			completionsResponse([
				{
					candidates: [
						{
							content: { parts: [{ text: "partial" }] },
							finishReason: "CONTINUATION",
							continuationToken: "do-not-follow",
						},
					],
				},
			]),
		);
		const result = await stream(
			getBuiltinModel("google-vertex", "gemini-3-flash-preview"),
			normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
			{ apiKey: "test-key", fetch },
		).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
		expect(result.rawStopReason).toBe("CONTINUATION");
		expect(result.stopReason).toBe("length");
	});
});
