import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { FeatureContext, FeatureSetup } from "../../src/core/features/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const filler = (tokens: number, label: string) => `${label} ${"x".repeat(Math.round(tokens * CHARS_PER_TOKEN))}`;

describe("a feature's boundary compaction request", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	/** A session with history to summarize; `order` records requests and compactions as they happen. */
	async function setup() {
		const order: string[] = [];
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: filler(2_000, `old ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "window-200k", contextWindow: 200_000 }],
			initialActiveToolNames: ["finish"],
			compactionPolicy: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
			builtinCompactionFactories: [
				(api: FeatureSetup) => {
					api.tools.register({
						name: "finish",
						label: "finish",
						description: "Finishes an item.",
						parameters: Type.Object({
							focus: Type.String(),
							abort: Type.Optional(Type.Boolean()),
							item: Type.Optional(Type.Boolean()),
						}),
						execute: async (_id, params, _signal, _update, ctx: FeatureContext) => {
							ctx.requestBoundaryCompaction({
								customInstructions: params.focus,
								...(params.item ? { requestedBy: "item" as const } : {}),
							});
							if (params.abort) ctx.abort();
							return { content: [{ type: "text", text: filler(3_000, "result") }], details: {} };
						},
					});
					api.bus.on("session_before_compact", async (event) => {
						order.push(`compact:${event.reason}:${event.requestedBy}:${event.customInstructions}`);
						return {
							compaction: {
								summary: "Checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindFeatures({});
		harness.session.refreshContext();
		const request =
			(label: string, calls: Array<{ focus: string; abort?: boolean; item?: boolean }> = []) =>
			() => {
				order.push(label);
				return calls.length
					? fauxAssistantMessage(
							calls.map((call) => fauxToolCall("finish", call)),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("end");
			};
		return { harness, order, request };
	}

	it("compacts between an item's done and the next request, in a multi-item run", async () => {
		const { harness, order, request } = await setup();
		harness.setResponses([
			request("request 1", [{ focus: "B1 done" }]),
			request("request 2", [{ focus: "B2 done" }]),
			request("request 3"),
		]);
		await harness.session.prompt("work");
		expect(order).toEqual([
			"request 1",
			"compact:threshold:agent:B1 done",
			"request 2",
			"compact:threshold:agent:B2 done",
			"request 3",
		]);
	});

	it("keeps the latest focus when several are requested before the next request", async () => {
		const { harness, order, request } = await setup();
		harness.setResponses([request("request 1", [{ focus: "first" }, { focus: "second" }]), request("request 2")]);
		await harness.session.prompt("work");
		expect(order).toEqual(["request 1", "compact:threshold:agent:second", "request 2"]);
	});

	it("carries who wrote the focus into the compaction", async () => {
		const { harness, order, request } = await setup();
		harness.setResponses([request("request 1", [{ focus: "B1 done", item: true }]), request("request 2")]);
		await harness.session.prompt("work");
		expect(order).toEqual(["request 1", "compact:threshold:item:B1 done", "request 2"]);
	});

	it("drops the request when the run is aborted", async () => {
		const { harness, order, request } = await setup();
		harness.setResponses([request("request 1", [{ focus: "gone", abort: true }]), request("request 2")]);
		await harness.session.prompt("work");
		harness.setResponses([request("request 3")]);
		await harness.session.prompt("again");
		expect(order.filter((line) => line.startsWith("compact"))).toEqual([]);
	});

	it("compacts nothing without a request", async () => {
		const { harness, order, request } = await setup();
		harness.setResponses([request("request 1")]);
		await harness.session.prompt("work");
		expect(order).toEqual(["request 1"]);
	});
});
