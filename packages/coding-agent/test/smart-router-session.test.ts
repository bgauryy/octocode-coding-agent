import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { registerSmartRouter, type RouteExplanation, type SmartRouterOptions } from "../src/core/smart-router/index.ts";
import { VIRTUAL_MODEL_STATE_ENTRY } from "../src/core/virtual-models.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

const cost = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

describe("smart router through session routing", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(options: SmartRouterOptions = {}, harnessOptions: HarnessOptions = {}) {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			...harnessOptions,
			models: [
				{ id: "cheap", reasoning: true, cost: cost(0.1, 0.4), contextWindow: 100_000 },
				{ id: "pricey", reasoning: true, cost: cost(5, 20), contextWindow: 400_000 },
			],
			tools: [echoTool],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		const decisions: RouteExplanation[] = [];
		const unregister = registerSmartRouter(runtime, { ...options, onDecision: (e) => decisions.push(e) });
		await runtime.refresh({ allowNetwork: false });
		harness.session.agent.streamFunction = (model, context, streamOptions) =>
			runtime.streamSimple(model, context, streamOptions);
		await harness.session.setModel(runtime.getModel("octocode", "auto-code")!);
		harness.session.setThinkingLevel("high");
		const dispatched = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "assistant" ? [`${message.model}:${message.thinkingLevel}`] : [],
			);
		return { harness, runtime, decisions, dispatched, unregister };
	}

	it("routes a simple prompt to the cheapest model and stores diagnostics on the branch", async () => {
		const { harness, decisions, dispatched } = await setup();
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("add a log line");

		expect(dispatched()).toEqual(["cheap:low"]);
		expect(harness.session.model).toMatchObject({ provider: "octocode", id: "auto-code" });
		expect(decisions).toHaveLength(1);
		const stored = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY ? [entry.data] : [],
			);
		expect(stored).toHaveLength(1);
		expect(JSON.stringify(stored[0])).not.toContain("add a log line");
		expect(stored[0]).toMatchObject({ state: { sticky: { key: "faux/cheap" }, seq: 1 } });
	});

	it("keeps the model across the tool loop and the next turn", async () => {
		const { harness, decisions, dispatched } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
		]);

		await harness.session.prompt("add a log line");
		await harness.session.prompt("thanks");

		expect(dispatched().map((entry) => entry.split(":")[0])).toEqual(["cheap", "cheap", "cheap"]);
		expect(decisions.map((entry) => entry.reason)).toEqual(["user", "continuation", "user"]);
		expect(decisions.map((entry) => entry.outcome)).toEqual(["selected", "sticky", "sticky"]);
	});

	it("fails over to another model when a request fails and retries", async () => {
		const { harness, decisions, dispatched } = await setup();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("add a log line");

		expect(decisions.map((entry) => entry.reason)).toEqual(["user", "retry"]);
		expect(decisions[1]).toMatchObject({ outcome: "failover", selected: "faux/pricey" });
		expect(decisions[1].failure).toEqual({ model: "faux/cheap", kind: "transient" });
		expect(dispatched().at(-1)?.startsWith("pricey")).toBe(true);
	});

	it("honors deny lists and fails loudly when nothing is left", async () => {
		const { harness, runtime, dispatched } = await setup({ deny: ["faux/cheap"] });
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("add a log line");
		expect(dispatched()[0].startsWith("pricey")).toBe(true);

		runtime.setHiddenModels({ faux: ["pricey"] });
		const virtual = runtime.getModel("octocode", "auto-code")!;
		await expect(runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "low" })).rejects.toThrow(
			/no usable model \(denied: 1\)/,
		);
	});

	it("does not route a cancelled request, and unregisters cleanly", async () => {
		const { runtime, unregister } = await setup();
		const virtual = runtime.getModel("octocode", "auto-code")!;
		const controller = new AbortController();
		controller.abort();
		await expect(
			runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "low", signal: controller.signal }),
		).rejects.toThrow(/cancelled|abort/i);
		unregister();
		expect(runtime.getModel("octocode", "auto-code")).toBeUndefined();
	});
});
