import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { hasSessionDispatch } from "../src/core/agent-session/dispatch.ts";
import { createHarness, getAssistantTexts } from "./suite/harness.ts";

it.each(["custom", "user"] as const)(
	"starts a %s follow-up after the previous dispatch was interrupted",
	async (kind) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = await createHarness({
			tools: [
				{
					name: "hold",
					label: "hold",
					description: "wait",
					parameters: Type.Object({}),
					execute: async () => {
						entered.resolve();
						await release.promise;
						return { content: [{ type: "text", text: "stopped" }], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (event) => {
						if (!event.aborted) return;
						if (kind === "custom")
							pi.sendMessage({ customType: "redirect", content: "new task", display: false }, { triggerTurn: true });
						else pi.sendUserMessage("new task");
					});
				},
			],
		});
		try {
			await h.session.bindExtensions({});
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				(_context, options) => {
					expect(options?.signal?.aborted).toBe(true);
					return fauxAssistantMessage("");
				},
				fauxAssistantMessage("redirected"),
			]);
			const running = h.session.prompt("work");
			await entered.promise;
			const aborting = h.session.abort();
			release.resolve();
			await Promise.all([running, aborting]);
			await vi.waitFor(() => expect(getAssistantTexts(h)).toContain("redirected"));
			expect(hasSessionDispatch(h.session)).toBe(false);
		} finally {
			release.resolve();
			h.cleanup();
		}
	},
);
