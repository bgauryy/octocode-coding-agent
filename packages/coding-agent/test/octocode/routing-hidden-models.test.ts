import { describe, expect, it } from "vitest";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { routingFacts } from "../../src/octocode/subagents/models-command.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { RoutingWatch, withReplacedProfileModels } from "../../src/octocode/subagents/routing-watch.ts";
import { visibleModels } from "../../src/core/provider-models.ts";

const m = (provider: string, id: string, input: number, output: number): ModelRef =>
	({ provider, id, cost: { input, output }, contextWindow: 200_000, input: ["text"], reasoning: true }) as ModelRef;
const opus = m("p", "opus", 4, 20);
const sonnet = m("p", "sonnet", 2, 10);
const haiku = m("p", "haiku", 0.1, 0.5);
const mini = m("q", "mini", 0.2, 1);
const pinned = { name: "scout", description: "Reads", model: "p/haiku" } as AgentProfile;
const none = () => false;

describe("routing with hidden models", () => {
	it("never routes a purpose or a profile to a hidden model and says so in the routing notice", () => {
		const all = [opus, sonnet, haiku, mini];
		const hidden = new Map([["p/haiku", "hidden in /providers"]]);
		const before = routingFacts(all, opus, [pinned], undefined, none)!;
		expect(before.profiles.scout).toContain("p/haiku");
		const available = visibleModels(all, { p: ["haiku"] });
		const after = withReplacedProfileModels(
			routingFacts(available, opus, [pinned], undefined, none),
			[pinned],
			hidden,
		)!;
		expect(after.small).not.toContain("haiku");
		expect(after.profiles.scout.startsWith("p/haiku")).toBe(false);
		expect(after.profiles.scout).toContain("p/haiku is gone: hidden in /providers");

		const watch = new RoutingWatch(none);
		watch.prompt(before);
		const notice = watch.notice(after)!;
		expect(notice).toContain("p/haiku is gone");
		expect(notice).toContain("p/opus");
	});

	it("leaves the facts alone when no profile model is hidden", () => {
		const facts = routingFacts([opus, sonnet], opus, [pinned], undefined, none);
		expect(withReplacedProfileModels(facts, [pinned], new Map())).toBe(facts);
	});

	it("says a profile's model is gone when its provider no longer serves it", () => {
		const facts = routingFacts([opus, sonnet], opus, [pinned], undefined, none);
		const out = withReplacedProfileModels(facts, [pinned], new Map([["p/haiku", "no longer available"]]))!;
		expect(out.profiles.scout).toMatch(/\(p\/haiku is gone: no longer available\)$/);
	});
});
