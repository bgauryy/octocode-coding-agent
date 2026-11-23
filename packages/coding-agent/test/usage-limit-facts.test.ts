import type { QuotaReading } from "@octocodeai/octocode-ai";
import type { Api, AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { describe, expect, it } from "vitest";
import {
	resetText,
	USAGE_LIMIT_ENTRY,
	usageLimitRecord,
	usageLimitResetsAt,
	waitSpan,
} from "../src/core/agent-session/usage-limit-facts.ts";
import { nextConnectedModel, type SwitchCandidateHost } from "../src/core/agent-session/usage-limit-switch.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0);

const failure = (errorMessage: string): AssistantMessage =>
	({
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-6.1",
		stopReason: "error",
		errorMessage,
	}) as AssistantMessage;

const plan = (usedFraction: number, resetsAt: number | undefined, window = "five_hour"): QuotaReading => ({
	provider: "openai-codex",
	window,
	label: "5h",
	usedFraction,
	...(resetsAt === undefined ? {} : { resetsAt }),
	kind: "plan",
	source: "header",
	observedAt: NOW,
});

describe("usageLimitResetsAt", () => {
	it("takes the time the failure names first", () => {
		expect(usageLimitResetsAt(failure('{"resets_in_seconds": 600}'), [plan(1, NOW + 9_000_000)], NOW)).toBe(
			NOW + 600_000,
		);
	});

	it("falls back to the latest reset among spent plan windows", () => {
		const readings = [plan(1, NOW + 3_600_000), plan(1, NOW + 7_200_000, "week"), plan(0.5, NOW + 9_000_000, "other")];
		expect(usageLimitResetsAt(failure("usage limit reached"), readings, NOW)).toBe(NOW + 7_200_000);
	});

	it("is undefined when nothing names a future time", () => {
		expect(usageLimitResetsAt(failure("usage limit reached"), [plan(1, NOW - 1), plan(0.9, NOW + 60_000)], NOW)).toBe(
			undefined,
		);
	});
});

describe("reset wording", () => {
	it.each([
		[40_000, "40s"],
		[45 * 60_000, "45m"],
		[2 * 3_600_000 + 10 * 60_000, "2h 10m"],
		[3 * 3_600_000, "3h"],
		[3 * 86_400_000 + 4 * 3_600_000, "3d 4h"],
	])("waitSpan(%i) is %s", (ms, text) => expect(waitSpan(ms)).toBe(text));

	it("names an unknown reset", () => expect(resetText(undefined, NOW)).toBe("reset time unknown"));
});

describe("usageLimitRecord", () => {
	it("reads the entry a child sends and nothing else", () => {
		const data = { provider: "openai-codex", model: "openai-codex/gpt-6.1", resetsAt: NOW };
		expect(usageLimitRecord({ type: "custom", customType: USAGE_LIMIT_ENTRY, data })).toEqual(data);
		expect(usageLimitRecord({ type: "custom", customType: "other", data })).toBe(undefined);
		expect(usageLimitRecord({ type: "custom", customType: USAGE_LIMIT_ENTRY, data: { provider: 1 } })).toBe(undefined);
	});
});

describe("nextConnectedModel", () => {
	const model = (provider: string, id: string, contextWindow = 200_000) =>
		({ provider, id, api: "openai-responses", contextWindow }) as Model<Api>;

	function host(
		available: Model<Api>[],
		options: { plan?: string[]; deprecated?: string[]; tokens?: number } = {},
	): SwitchCandidateHost {
		return {
			modelRuntime: {
				getAvailable: async () => available,
				getProviderBilling: (provider) => (options.plan?.includes(provider) ? "plan" : "metered"),
				isModelDeprecated: (m) => options.deprecated?.includes(`${m.provider}/${m.id}`) ?? false,
			},
			settingsManager: { getCompactionReserveTokens: () => 16_000 },
			contextTokens: options.tokens,
		};
	}
	const failed = { provider: "openai-codex", id: "gpt-6.1" };

	it("never offers the failed provider, and prefers plan billing over per-token billing", async () => {
		const pick = await nextConnectedModel(
			host([model("openai-codex", "gpt-6.1"), model("openai", "gpt-6.1"), model("github-copilot", "gpt-6.1-sol")], {
				plan: ["github-copilot"],
			}),
			failed,
		);
		expect(pick && `${pick.provider}/${pick.id}`).toBe("github-copilot/gpt-6.1-sol");
	});

	it("prefers the same model served elsewhere over a provider's default model", async () => {
		const pick = await nextConnectedModel(
			host([model("anthropic", "claude-opus-5-5"), model("openrouter", "openai/gpt-6.1")]),
			failed,
		);
		expect(pick && `${pick.provider}/${pick.id}`).toBe("openrouter/openai/gpt-6.1");
	});

	it("skips deprecated models and windows too small for the context", async () => {
		const candidates = [model("openai", "gpt-6.1"), model("anthropic", "claude-opus-5-5", 32_000)];
		expect(
			await nextConnectedModel(host(candidates, { deprecated: ["openai/gpt-6.1"], tokens: 100_000 }), failed),
		).toBe(undefined);
	});
});
