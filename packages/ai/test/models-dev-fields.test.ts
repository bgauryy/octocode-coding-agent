import { describe, expect, it } from "vitest";
import {
	getModelsDevCost,
	isModelsDevChat,
	modelsDevFields,
	modelsDevInput,
	modelsDevLimits,
	modelsDevTextOutput,
} from "../src/catalog/models-dev-fields.ts";

describe("models.dev field mappers", () => {
	it("maps one listing to Octocode's fields", () => {
		const fields = modelsDevFields("claude-new", {
			id: "claude-new",
			name: "Claude New",
			family: "claude-opus",
			reasoning: true,
			reasoning_options: [{ type: "effort", values: ["low", "high"] }],
			tool_call: true,
			modalities: { input: ["text", "image", "pdf"], output: ["text"] },
			limit: { context: 1_000_000, input: 900_000, output: 128_000 },
			cost: {
				input: 5,
				output: 25,
				cache_read: 0.5,
				tiers: [{ tier: { type: "context", size: 200_000 }, input: 10, output: 40 }],
			},
			status: "beta",
			release_date: "2026-11-20",
			last_updated: "2026-11-21",
		});
		expect(fields).toEqual({
			id: "claude-new",
			name: "Claude New",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 0,
				tiers: [{ inputTokensAbove: 200_000, input: 10, output: 40, cacheRead: 0.5, cacheWrite: 0 }],
			},
			contextWindow: 1_000_000,
			inputLimits: { maxInputTokens: 900_000 },
			maxTokens: 128_000,
			toolCall: true,
			chat: true,
			textOutput: true,
			reasoningOptions: [{ type: "effort", values: ["low", "high"] }],
			family: "claude-opus",
			status: "beta",
			releaseDate: "2026-11-20",
			lastUpdated: "2026-11-21",
		});
	});

	it("keeps defaults for sparse listings", () => {
		expect(modelsDevFields("bare", { id: "bare", name: "" })).toEqual({
			id: "bare",
			name: "bare",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
			toolCall: false,
			chat: true,
			textOutput: true,
		});
		expect(modelsDevLimits({ context: 0, output: -1 }, { contextWindow: 8, maxTokens: 2 })).toEqual({
			contextWindow: 8,
			maxTokens: 2,
		});
		expect(getModelsDevCost(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(modelsDevInput({ input: ["text", "audio"] })).toEqual(["text"]);
	});

	it("tells chat models that answer in text apart", () => {
		expect(isModelsDevChat({ type: "image" })).toBe(false);
		expect(isModelsDevChat({ type: "chat" })).toBe(true);
		expect(modelsDevTextOutput({ modalities: { input: ["text"], output: ["image"] } })).toBe(false);
	});
});
