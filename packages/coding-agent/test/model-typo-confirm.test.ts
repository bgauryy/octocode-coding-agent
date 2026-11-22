import type { Api, Model } from "@octocodeai/octocode-ai";
import { describe, expect, test, vi } from "vitest";
import { confirmUnlistedModel } from "../src/modes/interactive/interactive-mode/unlisted-model.ts";

function model(provider: string, id: string): Model<Api> {
	return { id, name: id, provider, api: "anthropic-messages" } as Model<Api>;
}

const models = [model("anthropic", "claude-sonnet-4-5"), model("openai", "gpt-4o")];

function context(answer: boolean) {
	return {
		session: { modelRuntime: { getModels: () => models } },
		showConfirmDialog: vi.fn(async () => answer),
	} as unknown as Parameters<typeof confirmUnlistedModel>[0] & { showConfirmDialog: ReturnType<typeof vi.fn> };
}

describe("confirming an unlisted model id in /model", () => {
	test("asks with the nearest ids and returns the custom model when confirmed", async () => {
		const ctx = context(true);
		const result = await confirmUnlistedModel(ctx, "anthropic/claude-sonet-4-5");
		expect(result).toMatchObject({ id: "claude-sonet-4-5", provider: "anthropic" });
		const [, message] = ctx.showConfirmDialog.mock.calls[0] as unknown as [string, string];
		expect(message).toContain("claude-sonnet-4-5");
	});

	test("returns declined when the user says no", async () => {
		expect(await confirmUnlistedModel(context(false), "anthropic/claude-sonet-4-5")).toBe("declined");
	});

	test("does not ask for a listed id, an unknown provider or bare text", async () => {
		const ctx = context(true);
		expect(await confirmUnlistedModel(ctx, "anthropic/claude-sonnet-4-5")).toBeUndefined();
		expect(await confirmUnlistedModel(ctx, "nope/x")).toBeUndefined();
		expect(await confirmUnlistedModel(ctx, "claude")).toBeUndefined();
		expect(ctx.showConfirmDialog).not.toHaveBeenCalled();
	});
});
