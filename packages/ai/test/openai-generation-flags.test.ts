/**
 * Every OpenAI model of the explicit-cache generation (GPT-5.6 and later) must get the same mid-conversation cache
 * flags from the model generator as the other models of its family (gpt-6.1-terra like gpt-6.1-sol). A missing flag
 * makes section updates, tool additions and effort changes rewrite the cached prefix instead of appending to it.
 *
 * The test runs the generator functions on bare models, so it guards the generator inputs; the checked-in catalog
 * picks a fix up only after `generate:models` runs.
 */
import { describe, expect, it } from "vitest";
import {
	applyOpenAICompletionsTranscriptMetadata,
	applyOpenAIMidConvoEffortMetadata,
	applyOpenAIResponsesTranscriptMetadata,
	applyOpenAIToolSearchMetadata,
} from "../scripts/generate-models/openai-compat.ts";
import { applyUpstreamCorrections } from "../scripts/generate-models/upstream-corrections.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";
import { withCacheCapabilities } from "../src/utils/cache-capabilities.ts";

const MID_CONVO_FLAGS = [
	"supportsToolSearch",
	"supportsAdditionalTools",
	"supportsMidConvoSystemMessages",
	"supportsMidConvoEffort",
] as const;

const ROUTES: { provider: string; api: Api; baseUrl: string; prefix?: string }[] = [
	{ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "github-copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com" },
	{ provider: "opencode", api: "openai-responses", baseUrl: "https://opencode.ai/zen/v1" },
	{ provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", prefix: "openai/" },
];

function getsExplicitMode(model: Model<Api>): boolean {
	const compat = withCacheCapabilities(model).compat ?? {};
	return "supportsExplicitPromptCacheMode" in compat && compat.supportsExplicitPromptCacheMode === true;
}

/** OpenAI model ids that get explicit cache mode: the GPT-5.6+ generation. */
const explicitIds = getBuiltinModels("openai")
	.filter((model) => model.api === "openai-responses")
	.filter((model) => getsExplicitMode({ ...model, compat: {} }))
	.map((model) => model.id);

/** gpt-6.1-terra and gpt-6.1-sol share the family gpt-6.1; gpt-daybreak-blue-latest is in gpt-daybreak. */
function family(id: string): string {
	return id.startsWith("gpt-daybreak-") ? "gpt-daybreak" : id.replace(/-[a-z]+$/, "");
}

function generatedFlags(route: (typeof ROUTES)[number], id: string): string[] {
	const model = {
		id: `${route.prefix ?? ""}${id}`,
		name: id,
		api: route.api,
		provider: route.provider,
		baseUrl: route.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	} as Model<Api>;
	applyOpenAIToolSearchMetadata(model);
	applyOpenAICompletionsTranscriptMetadata(model);
	applyOpenAIResponsesTranscriptMetadata(model);
	applyOpenAIMidConvoEffortMetadata(model);
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	return MID_CONVO_FLAGS.filter((flag) => compat[flag] === true);
}

const families = new Map<string, string[]>();
for (const id of explicitIds) families.set(family(id), [...(families.get(family(id)) ?? []), id]);
const siblingRows = ROUTES.flatMap((route) =>
	[...families.values()]
		.filter((ids) => ids.length > 1)
		.flatMap((ids) => ids.slice(1).map((id) => ({ route: route.provider, routeRow: route, id, reference: ids[0] }))),
);

describe("explicit-cache generation: mid-conversation flags match the family", () => {
	it("finds GPT-6.1 Sol and Terra in one family", () => {
		expect(families.get("gpt-6.1")).toEqual(expect.arrayContaining(["gpt-6.1-sol", "gpt-6.1-terra"]));
	});

	it.each(siblingRows)("$route $id carries the flags of $reference", ({ routeRow, id, reference }) => {
		expect(generatedFlags(routeRow, id)).toEqual(generatedFlags(routeRow, reference));
	});

	it("gives gpt-6.1-terra tool search, additional tools, mid-conversation developer messages and effort updates", () => {
		expect(generatedFlags(ROUTES[0], "gpt-6.1-terra")).toEqual([...MID_CONVO_FLAGS]);
	});
});

describe("explicit-cache generation: long-context pricing matches the family", () => {
	function corrected(id: string): Model<Api> {
		const model = {
			id,
			name: id,
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			// A stale upstream price: OPENAI_STANDARD_COSTS must win.
			cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
			contextWindow: 1050000,
			maxTokens: 128000,
		} as Model<Api>;
		applyUpstreamCorrections([model]);
		return model;
	}

	it.each(["gpt-6.1-sol", "gpt-6.1-terra"])("%s is capped to the short-context tier with long-context prices", (id) => {
		const model = corrected(id);
		expect(model.contextWindow).toBe(272000);
		expect(model.cost.tiers).toEqual([expect.objectContaining({ inputTokensAbove: 272000 })]);
	});

	it("uses OpenAI's published gpt-6.1-terra prices", () => {
		expect(corrected("gpt-6.1-terra").cost).toEqual({
			input: 1,
			output: 5,
			cacheRead: 0.05,
			cacheWrite: 1.25,
			tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
		});
	});
});
