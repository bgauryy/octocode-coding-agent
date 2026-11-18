import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { sharedSummary } from "../../src/octocode/compaction/shared-summary.ts";
import { createHarness } from "./harness.ts";

it.each(["forced", "normal", "cleared", "moved", "unsent"] as const)(
	"shares the last %s live system prefix when writing a compaction summary",
	async (mode) => {
		const requests: TranscriptContext[] = [];
		let turn = 0;
		const harness = await createHarness({
			tools: [],
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("before_agent_start", () => {
						turn++;
						return mode === "forced" ||
							(mode === "cleared" && turn === 1) ||
							((mode === "moved" || mode === "unsent") && turn === 2)
							? { systemPrompt: "Use this exact transient prompt." }
							: undefined;
					});
					api.bus.on("session_before_compact", async (event, ctx) => ({
						compaction: await sharedSummary(api, event, ctx, ctx.model!, "Preserve the objective."),
					}));
				},
			],
		});
		try {
			const capture = (text: string) => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage(text);
			};
			harness.setResponses([
				capture("A completed step."),
				...(mode === "cleared" || mode === "moved" ? [capture("Another step.")] : []),
				capture("## Goal\nPreserve the objective."),
			]);
			await harness.session.prompt("Implement the objective.");
			const firstLeaf = harness.sessionManager.getLeafId()!;
			if (mode === "cleared" || mode === "moved") await harness.session.prompt("Continue the objective.");
			if (mode === "unsent") {
				const convert = harness.session.agent.convertToLlm;
				harness.session.agent.convertToLlm = () => {
					throw new Error("Conversion failed before provider dispatch");
				};
				try {
					await harness.session.prompt("Continue the objective.");
				} finally {
					harness.session.agent.convertToLlm = convert;
				}
				expect(requests).toHaveLength(1);
			}
			if (mode === "moved") {
				harness.sessionManager.branch(firstLeaf);
				harness.session.refreshContext();
			}
			await harness.session.compact();
			expect(requests).toHaveLength(mode === "cleared" || mode === "moved" ? 3 : 2);
			const live = mode === "moved" ? requests[0] : requests.at(-2)!;
			const summary = requests.at(-1)!;
			if (mode === "forced")
				expect(live.messages[0]).toMatchObject({ role: "system", content: "Use this exact transient prompt." });
			expect(summary.messages.slice(0, live.messages.length)).toEqual(live.messages);
			expect(JSON.stringify(summary.messages.slice(0, live.messages.length))).toBe(JSON.stringify(live.messages));
			expect(summary.messages.filter((message) => message.role === "system")).toEqual(
				live.messages.filter((message) => message.role === "system"),
			);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("Use this exact transient prompt.");
		} finally {
			harness.cleanup();
		}
	},
);
