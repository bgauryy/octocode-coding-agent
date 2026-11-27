import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { estimateProjectedContextTokens } from "../src/core/compaction/tokens.ts";
import { createHarness } from "./suite/harness.ts";

const cases = (["steering", "section", "tool", "small", "during", "selected"] as const).flatMap((kind) =>
	(kind === "small" || kind === "selected" ? [false] : [false, true]).map((cancel) => ({ kind, cancel })),
);

it.each(cases)(
	"checks committed $kind content before a physical continuation request (cancel: $cancel)",
	async ({ kind, cancel }) => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const compacting = Promise.withResolvers<void>();
		const compactionReleased = Promise.withResolvers<void>();
		const order: string[] = [];
		// About 2,300 tokens at the default 2.5 characters per token: over the threshold with the history, within the
		// window after a compaction.
		const large = `large-content:${"x".repeat(5750)}`;
		const pauseCompaction = kind === "during" || kind === "selected";
		let refreshSection = false;
		let tokensBeforeCompaction = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
			compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 500 },
			tools: [
				{
					name: "wait",
					label: "Wait",
					description: "Waits for queued input",
					parameters: Type.Object({}),
					execute: async () => {
						started.resolve();
						await released.promise;
						refreshSection = kind === "section" || pauseCompaction;
						return { content: [{ type: "text", text: kind === "tool" ? large : "ok" }], details: {} };
					},
				},
			],
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("user_input", (event) => {
						if (event.text === "direction queued during late compaction")
							return cancel ? { block: true } : { additionalContext: ["late input passed the gate"] };
						return {};
					});
					api.bus.on("turn_prompt", (event) => {
						if (refreshSection) event.systemPromptOptions.sections.request_status = large;
					});
					api.bus.on("session_before_compact", async (event) => {
						order.push("compaction");
						tokensBeforeCompaction = event.preparation.tokensBefore;
						if (pauseCompaction) {
							compacting.resolve();
							await compactionReleased.promise;
						}
						if (cancel) return { cancel: true };
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		let running: Promise<void> | undefined;
		let dispatched = "";
		try {
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				(context) => {
					order.push("provider");
					dispatched = JSON.stringify(context.messages);
					for (const message of context.messages) {
						if (message.role !== "toolResult") continue;
						expect(
							context.messages.some(
								(candidate) =>
									candidate.role === "assistant" &&
									candidate.content.some((part) => part.type === "toolCall" && part.id === message.toolCallId),
							),
						).toBe(true);
					}
					return fauxAssistantMessage("finished");
				},
				fauxAssistantMessage("finished"),
			]);
			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			running = harness.session.prompt("run wait");
			await started.promise;
			expect(
				estimateProjectedContextTokens(
					harness.sessionManager.buildSessionProjection(),
					harness.sessionManager.getBranch(),
				).tokens,
			).toBeLessThan(2800);
			if (kind === "steering" || kind === "small")
				await harness.session.steer(kind === "steering" ? large : "small input");
			if (kind === "selected") await harness.session.steer("already selected direction");
			released.resolve();
			if (pauseCompaction) {
				await compacting.promise;
				await harness.session.steer("direction queued during late compaction");
				compactionReleased.resolve();
			}
			await running;
			if (kind === "during") {
				if (cancel) {
					expect(dispatched).toBe("");
					expect(harness.faux.state.callCount).toBe(3);
					expect(order).toEqual(["compaction"]);
					return;
				}
				expect(dispatched).toContain("direction queued during late compaction");
				expect(dispatched).toContain("late input passed the gate");
			}
			expect(harness.session.getLastAssistantText()).toBe("finished");
			expect(harness.faux.state.callCount).toBe(kind === "selected" ? 5 : 4);
			if (kind === "selected") {
				expect(dispatched).toContain("already selected direction");
				expect(dispatched).not.toContain("direction queued during late compaction");
				expect(JSON.stringify(harness.session.messages)).toContain("late input passed the gate");
			}
			if (kind === "small") {
				expect(order).toEqual(["provider"]);
				expect(dispatched).toContain("small input");
			} else {
				expect(order).toEqual(["compaction", "provider"]);
				expect(tokensBeforeCompaction).toBeGreaterThan(2800);
				expect(dispatched).toContain(large);
				if (cancel) {
					expect(harness.eventsOfType("compaction_end")).toContainEqual(expect.objectContaining({ aborted: true }));
				} else {
					expect(dispatched).toContain("compacted history");
				}
			}
		} finally {
			released.resolve();
			compactionReleased.resolve();
			await running;
			harness.cleanup();
		}
	},
);
