import { describe, expect, it, vi } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	api: "test",
	provider: "test",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

describe("lazy setup cancellation", () => {
	it("preserves AbortError classification in both the terminal event and result", async () => {
		const observed = vi.fn();
		const stream = lazyStream(
			model,
			async () => {
				throw new DOMException("Cancelled", "AbortError");
			},
			{ onResult: observed },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(events).toEqual([{ type: "error", reason: "aborted", error: result }]);
		expect(observed).toHaveBeenCalledExactlyOnceWith(result);
	});

	it.each(["stream", "streamSimple", "streamDeferred"] as const)(
		"classifies custom-reason cancellation during %s authentication without dispatching",
		async (method) => {
			const controller = new AbortController();
			const dispatch = vi.fn(() => {
				throw new Error("must not dispatch");
			});
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: {
						apiKey: {
							name: "Test",
							resolve: async () => {
								controller.abort(new Error("User stopped authentication"));
								controller.signal.throwIfAborted();
								return { auth: {} };
							},
						},
					},
					api: {
						stream: dispatch,
						streamSimple: dispatch,
						fetchDeferred: dispatch,
					},
				}),
			);
			const options = { signal: controller.signal };
			const stream =
				method === "streamDeferred"
					? models.streamDeferred(
							model,
							{
								api: model.api,
								provider: model.provider,
								modelId: model.id,
								id: "test",
							},
							options,
						)
					: models[method](model, { messages: [] }, options);
			const result = await stream.result();
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toContain("User stopped authentication");
			expect(dispatch).not.toHaveBeenCalled();
		},
	);

	it("keeps non-abort setup failures as errors", async () => {
		const result = await lazyStream(model, async () => {
			throw new Error("Invalid configuration");
		}).result();
		expect(result.stopReason).toBe("error");
	});
});
