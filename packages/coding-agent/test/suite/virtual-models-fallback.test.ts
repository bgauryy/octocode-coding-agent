import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetFallbackExhaustion } from "../../src/core/agent-session/retry-fallback.ts";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const LIMIT = "429 insufficient_quota: You exceeded your current quota";

describe("usage limits under a virtual model", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => resetFallbackExhaustion());
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** A router that moves off a model that failed and otherwise starts on `large`. */
	async function createRoutedHarness() {
		const requests: ModelRouteRequest[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			models: [
				{ id: "small", contextWindow: 50_000 },
				{ id: "large", contextWindow: 50_000 },
			],
			builtinCompactionFactories: [
				(api) => {
					api.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						contextWindow: 50_000,
						route(request, ctx) {
							requests.push(request);
							const other = request.failed?.model.id === "large" ? "small" : "large";
							return { model: ctx.modelRegistry.find("faux", other)!, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		const dispatched = () =>
			harness.session.messages.flatMap((message) => (message.role === "assistant" ? [message.model] : []));
		return { harness, requests, dispatched };
	}

	it("hands the failure to the router, which continues the turn on another model", async () => {
		const { harness, requests, dispatched } = await createRoutedHarness();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: LIMIT }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(requests.map((request) => request.reason)).toEqual(["user", "retry"]);
		expect(requests[1].failed?.model.id).toBe("large");
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(dispatched().at(-1)).toBe("small");
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
	});

	it("hands each failing model to the router once, then ends the turn with the error", async () => {
		const { harness, requests } = await createRoutedHarness();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: LIMIT }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: LIMIT }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: LIMIT }),
		]);

		await harness.session.prompt("hello");

		expect(requests.map((request) => request.reason)).toEqual(["user", "retry", "retry"]);
		expect(requests.slice(1).map((request) => request.failed?.model.id)).toEqual(["large", "small"]);
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" && last.errorMessage).toContain("insufficient_quota");
	});
});
