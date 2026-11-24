import type { Api, AssistantMessage, Message, Model, ProviderPlan } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import {
	type CandidateFacts,
	decide,
	type DecisionInput,
	type SmartRouterOptions,
	SmartRouterError,
	type SmartRouterState,
} from "../src/core/smart-router/index.ts";
import { readState } from "../src/core/smart-router/state.ts";

function model(id: string, extra: Partial<Model<Api>> = {}, provider = "p"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8000,
		...extra,
	};
}

const light = model("light", { cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } });
const mid = model("mid", { reasoning: true });
const heavy = model("heavy", {
	reasoning: true,
	contextWindow: 400_000,
	cost: { input: 5, output: 20, cacheRead: 0, cacheWrite: 0 },
});

function fact(m: Model<Api>, extra: Partial<CandidateFacts> = {}): CandidateFacts {
	return {
		model: m,
		configured: true,
		providerDisabled: false,
		hidden: false,
		deprecated: false,
		accessRejected: false,
		...extra,
	};
}

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const emptyState = (): SmartRouterState => ({ v: 1, seq: 0, failures: 0, cooldowns: [] });

function run(overrides: Partial<DecisionInput> = {}, options: SmartRouterOptions = {}) {
	return decide({
		reason: "user",
		thinkingLevel: "high",
		messages: [user("add a log line")],
		state: emptyState(),
		facts: [fact(light), fact(mid), fact(heavy)],
		options,
		...overrides,
	});
}

function failure(m: Model<Api>, errorMessage: string, stopReason: "error" | "aborted" | "length" = "error") {
	const message = {
		role: "assistant",
		content: [],
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage: {},
		stopReason,
		errorMessage,
		timestamp: 2,
	} as unknown as AssistantMessage;
	return { model: m, message };
}

describe("smart router hard filters", () => {
	it.each([
		["no-credentials", { configured: false }],
		["provider-disabled", { providerDisabled: true }],
		["hidden", { hidden: true }],
		["deprecated", { deprecated: true }],
		["access-rejected", { accessRejected: true }],
	] as const)("never routes to a model that is %s", (reason, flag) => {
		const decision = run({ facts: [fact(light, flag), fact(mid)] });
		expect(decision.model.id).toBe("mid");
		expect(decision.explanation.rejected[reason]?.models).toEqual(["p/light"]);
	});

	it("honors allow and deny, with deny winning", () => {
		expect(run({}, { allow: ["p/h*", "p/mid"], deny: ["p/heavy"] }).model.id).toBe("mid");
		expect(() => run({}, { allow: ["p/light"], deny: ["p/*"] })).toThrow(SmartRouterError);
	});

	it("requires image input for a pending image only", () => {
		const image: Message = {
			role: "user",
			content: [{ type: "image", data: "x", mimeType: "image/png" }],
			timestamp: 1,
		};
		const vision = model("vision", { input: ["text", "image"] });
		expect(run({ messages: [image], facts: [fact(light), fact(vision)] }).model.id).toBe("vision");
		const answered = { ...failure(light, "").message, stopReason: "stop", errorMessage: undefined } as AssistantMessage;
		expect(run({ messages: [image, answered, user("thanks")], facts: [fact(light)] }).model.id).toBe("light");
	});

	it("checks context room and treats an unknown window as a last resort", () => {
		const big = user("x".repeat(40_000));
		const small = model("small", { contextWindow: 8000 });
		expect(run({ messages: [big], facts: [fact(small), fact(mid)] }).model.id).toBe("mid");
		const unknown = model("unknown", { contextWindow: 0 });
		expect(run({ facts: [fact(unknown), fact(mid)] }).model.id).toBe("mid");
		const only = run({ facts: [fact(unknown)] });
		expect(only.model.id).toBe("unknown");
		expect(only.explanation.notes.join()).toContain("context window unknown");
		expect(() => run({ messages: [big], facts: [fact(small)] })).toThrow(/context: 1/);
	});

	it("never exposes prompt content in explanations", () => {
		const decision = run({ messages: [user("secret-token-123 refactor the architecture")] });
		expect(JSON.stringify(decision.explanation)).not.toContain("secret-token-123");
		expect(JSON.stringify(decision.state)).not.toContain("secret-token-123");
	});
});

describe("smart router billing policy", () => {
	const plan: ProviderPlan = { billing: "plan", access: "direct", terms: "https://example.test" };
	const planned = (m: Model<Api>, extra: Partial<ProviderPlan> = {}) => fact(m, { plan: { ...plan, ...extra } });

	it("prefers a plan model over a cheaper per-token model", () => {
		expect(run({ facts: [fact(light), planned(mid)] }).model.id).toBe("mid");
	});

	it("skips plans the vendor restricts", () => {
		expect(run({ facts: [planned(mid, { access: "external-only" }), fact(heavy)] }).model.id).toBe("heavy");
		expect(run({ facts: [planned(mid, { unattended: false }), fact(heavy)] }, { unattended: true }).model.id).toBe(
			"heavy",
		);
		expect(run({ facts: [planned(mid, { disabled: "paused" }), fact(heavy)] }).model.id).toBe("heavy");
	});

	it("never escalates from a plan to per-token billing without permission", () => {
		const facts = [planned(mid), fact(heavy)];
		const first = run({ facts });
		expect(first.state.usedPlan).toBe(true);
		const next = { ...run({ facts }), reason: "user" as const };
		const failed = failure(mid, "overloaded");
		// The plan model fails; the per-token model is the only other model, and it stays blocked.
		const retry = run({ facts, state: next.state, reason: "retry", failed, previous: { model: mid } });
		expect(retry.model.id).toBe("mid");
		expect(retry.explanation.notes.join()).toContain("cooldowns relaxed");
		expect(retry.explanation.rejected["plan-to-metered"]?.models).toEqual(["p/heavy"]);
		const allowed = run(
			{ facts, state: next.state, reason: "retry", failed, previous: { model: mid } },
			{ allowPlanToMeteredEscalation: true },
		);
		expect(allowed.model.id).toBe("heavy");
		expect(allowed.explanation.outcome).toBe("failover");
	});

	it("supports plan-only", () => {
		expect(run({ facts: [fact(light), planned(mid)] }, { planOnly: true }).model.id).toBe("mid");
		expect(() => run({ facts: [fact(light)] }, { planOnly: true })).toThrow(/plan-only: 1/);
	});
});

describe("smart router selection", () => {
	it("picks the cheapest model that meets the task and is deterministic", () => {
		const a = run();
		const b = run({ facts: [fact(heavy), fact(mid), fact(light)] });
		expect(a.model.id).toBe("light");
		expect(b.model.id).toBe("light");
		expect(a.explanation).toEqual(b.explanation);
		const hard = run({ messages: [user("refactor the architecture and fix the race condition " + "x".repeat(4100))] });
		expect(hard.explanation.complexity.level).toBe(3);
		expect(hard.model.id).toBe("heavy");
		expect(hard.explanation.selectedTier).toBe(3);
	});

	it("uses supplied tiers, statistics and cost over metadata", () => {
		const cheap = model("cheap");
		const other = model("other");
		const facts = [fact(cheap), fact(other)];
		expect(
			run({ facts }, { statistics: (m) => (m.id === "cheap" ? { costPerRequestUsd: 9 } : { costPerRequestUsd: 1 }) })
				.model.id,
		).toBe("other");
		expect(
			run({ facts }, { statistics: (m) => (m.id === "cheap" ? { successRate: 0.2, samples: 50 } : undefined) }).model
				.id,
		).toBe("other");
		expect(
			run({ facts }, { statistics: (m) => (m.id === "cheap" ? { successRate: 0.2, samples: 1 } : undefined) }).model.id,
		).toBe("cheap");
		expect(run({ facts: [fact(light), fact(mid)] }, { tiers: { "p/mid": 3, "p/light": 1 }, deny: [] }).model.id).toBe(
			"light",
		);
		const hard = run(
			{ facts: [fact(light), fact(mid)], messages: [user("refactor the architecture " + "x".repeat(4100))] },
			{ tiers: { "p/mid": 3, "p/light": 1 } },
		);
		expect(hard.model.id).toBe("mid");
	});

	it("falls back to a stable choice when metadata is absent", () => {
		const bare = (id: string) =>
			model(id, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
		const decision = run({ facts: [fact(bare("b")), fact(bare("a"))] });
		expect(decision.model.id).toBe("a");
		expect(decision.explanation.selectedTier).toBe(2);
	});
});

describe("smart router stickiness, effort and failures", () => {
	const facts = [fact(light), fact(mid), fact(heavy)];

	it("keeps the sticky model while it is usable, even when another would now rank first", () => {
		const first = run({ facts: [fact(mid), fact(heavy)] });
		expect(first.model.id).toBe("mid");
		const second = run({ facts, state: first.state, reason: "continuation", previous: { model: mid } });
		expect(second.model.id).toBe("mid");
		expect(second.explanation.outcome).toBe("sticky");
	});

	it("raises effort before it switches models", () => {
		const weak = model("weak", { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const set = [fact(weak), fact(heavy)];
		const tiers = { "p/weak": 1 as const, "p/heavy": 3 as const };
		const easy = run({ facts: set }, { tiers });
		expect(easy.model.id).toBe("weak");
		const hardMessages = [user("refactor the architecture " + "x".repeat(4100))];
		// Required tier 3, the weak model is tier 1: needs effort 4+2=6, above the "high" ceiling, so it switches.
		const switched = run(
			{ facts: set, messages: hardMessages, state: easy.state, previous: { model: weak } },
			{ tiers },
		);
		expect(switched.model.id).toBe("heavy");
		expect(switched.explanation.outcome).toBe("model-switched");
		// With a higher ceiling the same model absorbs the deficit through effort.
		const raised = run(
			{ facts: set, messages: hardMessages, state: easy.state, previous: { model: weak }, thinkingLevel: "max" },
			{ tiers },
		);
		expect(raised.model.id).toBe("weak");
		expect(raised.explanation.outcome).toBe("effort-raised");
		expect(raised.thinkingLevel).toBe("max");
	});

	it("never raises effort above the selected level, and a non-reasoning model stays off", () => {
		expect(run({ thinkingLevel: "off" }).thinkingLevel).toBe("off");
		expect(run({ facts: [fact(light)] }).thinkingLevel).toBe("off");
	});

	it("raises effort first after a truncated response, then moves up", () => {
		const first = run({ facts: [fact(mid), fact(heavy)], thinkingLevel: "medium" });
		expect(first.thinkingLevel).toBe("low");
		const length = failure(mid, "", "length");
		const retry = run({
			facts: [fact(mid), fact(heavy)],
			thinkingLevel: "medium",
			state: first.state,
			reason: "retry",
			failed: length,
			previous: { model: mid },
		});
		expect(retry.model.id).toBe("mid");
		expect(retry.thinkingLevel).toBe("medium");
		const again = run({
			facts: [fact(mid), fact(heavy)],
			thinkingLevel: "medium",
			state: retry.state,
			reason: "retry",
			failed: length,
			previous: { model: mid },
		});
		expect(again.model.id).toBe("heavy");
		expect(again.explanation.outcome).toBe("model-switched");
	});

	it("fails over from a transient failure and returns after the cooldown", () => {
		const first = run({ facts: [fact(light), fact(mid)] });
		const failed = failure(light, "overloaded_error");
		const retry = run({ facts: [fact(light), fact(mid)], state: first.state, reason: "retry", failed });
		expect(retry.model.id).toBe("mid");
		expect(retry.explanation.failure).toEqual({ model: "p/light", kind: "transient" });
		expect(retry.state.cooldowns).toHaveLength(1);
		let state = retry.state;
		for (let i = 0; i < 5; i++) state = run({ facts: [fact(light), fact(mid)], state, reason: "continuation" }).state;
		expect(state.cooldowns).toEqual([]);
	});

	it("does not penalize a cancelled request", () => {
		const first = run();
		const retry = run({
			state: first.state,
			reason: "retry",
			failed: failure(light, "", "aborted"),
			previous: { model: light },
		});
		expect(retry.model.id).toBe("light");
		expect(retry.state.failures).toBe(0);
		expect(retry.state.cooldowns).toEqual([]);
	});

	it("needs a larger window after a context overflow", () => {
		const tight = model("tight", { contextWindow: 20_000 });
		const roomy = model("roomy", { contextWindow: 200_000 });
		const messages = [user("x".repeat(60_000))];
		const decision = run({
			facts: [fact(tight), fact(roomy)],
			messages,
			reason: "retry",
			failed: failure(tight, "prompt is too long: 120000 tokens > 20000 maximum"),
		});
		expect(decision.model.id).toBe("roomy");
		expect(decision.explanation.failure?.kind).toBe("context");
	});

	it("resets the failure count once a request is not a retry", () => {
		const first = run();
		const failed = run({ state: first.state, reason: "retry", failed: failure(light, "overloaded") });
		expect(failed.state.failures).toBe(1);
		expect(run({ state: failed.state, reason: "continuation" }).state.failures).toBe(0);
	});
});

describe("smart router state", () => {
	it("stays bounded and drops malformed state", () => {
		let state = emptyState();
		const facts = Array.from({ length: 40 }, (_, i) => fact(model(`m${String(i).padStart(2, "0")}`)));
		for (let i = 0; i < 40; i++) {
			const sticky = state.sticky?.key.split("/")[1];
			const failed = failure(facts.find((f) => f.model.id === sticky)?.model ?? facts[0].model, "overloaded");
			state = run({ facts, state, reason: "retry", failed }, { cooldownRequests: 100 }).state;
		}
		expect(state.cooldowns.length).toBeLessThanOrEqual(16);
		expect(JSON.stringify(state).length).toBeLessThan(6000);
		expect(readState({ v: 2 })).toEqual(emptyState());
		expect(readState({ v: 1, seq: -1, cooldowns: [{ key: 1 }, "x"], sticky: { key: "p/a", effort: "bogus" } })).toEqual(
			{
				v: 1,
				seq: 0,
				failures: 0,
				cooldowns: [],
			},
		);
		expect(readState(JSON.parse(JSON.stringify(state)))).toMatchObject({ seq: state.seq });
	});
});
