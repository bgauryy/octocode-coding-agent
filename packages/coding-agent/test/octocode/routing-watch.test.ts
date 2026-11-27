import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { routingFacts } from "../../src/octocode/subagents/models-command.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { ProviderHealth } from "../../src/octocode/subagents/provider-health.ts";
import { latestFallback, ROUTING_NOTICE_ID, RoutingWatch } from "../../src/octocode/subagents/routing-watch.ts";
import { FALLBACK_ENTRY } from "../../src/core/agent-session/fallback-switch.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost, meteredBilling } from "./fake-host.ts";
import { allSections, tmp } from "./helpers.ts";

const m = (provider: string, id: string, input: number, output: number): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
	input: ["text", "image"],
	reasoning: true,
});
const opus = m("p", "opus", 4, 20);
const sonnet = m("p", "sonnet", 2, 10);
const haiku = m("p", "haiku", 0.1, 0.5);
const other = m("q", "mini", 0.2, 1);
const researcher = { name: "researcher", description: "Reads code", model: "small" } as AgentProfile;
const none = () => false;

describe("routing facts", () => {
	it("names the session model, providers with a usable model, each purpose and each profile's route", () => {
		expect(routingFacts([opus, sonnet, haiku, other], opus, [researcher], undefined, none)).toEqual({
			sessionModel: "p/opus",
			providers: [
				{ id: "p", count: 3 },
				{ id: "q", count: 1 },
			],
			small: "p/haiku",
			medium: "p/sonnet",
			profiles: { researcher: "p/haiku:medium" },
		});
		// A provider that refused its credential is not offered.
		expect(routingFacts([opus, other], opus, [], undefined, (provider) => provider === "q")?.providers).toEqual([
			{ id: "p", count: 1 },
		]);
		expect(routingFacts([], opus, [], undefined, none)).toBeUndefined();
		expect(routingFacts([opus], undefined, [], undefined, none)).toBeUndefined();
	});
});

/** The notice one watch gives for a change, given which providers the harness knows refused their credential. */
type Facts = Parameters<RoutingWatch["prompt"]>[0];
const noticeFor = (refused: (provider: string) => boolean, before: Facts, after: Facts) => {
	const each = new RoutingWatch(refused);
	each.prompt(before);
	return each.notice(after);
};

describe("RoutingWatch", () => {
	const facts = (providers: string[], small = "p/haiku", count = 2) => ({
		sessionModel: "p/opus",
		providers: providers.map((id) => ({ id, count })),
		small,
		medium: "p/sonnet",
		profiles: { researcher: `${small}:medium` },
	});

	it("tells a change in a provider's runnable count even when the providers stay the same", () => {
		const watch = new RoutingWatch();
		watch.prompt(facts(["p", "q"], "p/haiku", 2));
		const notice = watch.notice(facts(["p", "q"], "p/haiku", 5));
		expect(notice).toContain("`p` (5), `q` (5)");
		expect(notice).not.toContain("added");
	});

	it("tells a change again after compaction, which drops the notice while the prompt keeps the old facts", () => {
		const watch = new RoutingWatch();
		const first = facts(["p", "q"]);
		watch.prompt(first);
		const changed = facts(["p"], "p/tiny");
		expect(watch.notice(changed)).toBeDefined();
		watch.compacted();
		expect(watch.notice(changed)).toContain("(no longer available: `q`)");
		expect(watch.notice(changed)).toBeUndefined();
		// Facts that match the prompt again need no notice after compaction.
		watch.compacted();
		expect(watch.notice(first)).toBeUndefined();
	});

	it("freezes the prompt's facts per session and tells each later change once", () => {
		const watch = new RoutingWatch();
		const first = facts(["p", "q"]);
		expect(watch.prompt(first)).toBe(first);
		expect(watch.notice(first)).toBeUndefined();
		const changed = facts(["p", "r"], "r/tiny");
		// The prompt keeps the frozen facts: its cached prefix does not move.
		expect(watch.prompt(changed)).toBe(first);
		const notice = watch.notice(changed);
		expect(notice).toContain(`[${ROUTING_NOTICE_ID}]`);
		expect(notice).toContain(
			"Providers (models that can run a task): `p` (2), `r` (2) (added `r`) (no longer available: `q`).",
		);
		expect(notice).toContain("`small` runs `r/tiny`; `medium` runs `p/sonnet`. Profiles: researcher `r/tiny:medium`.");
		expect(watch.notice(changed)).toBeUndefined();
		watch.reset();
		expect(watch.prompt(changed)).toBe(changed);
		expect(watch.notice(changed)).toBeUndefined();
	});
});

describe("RoutingWatch notice cause", () => {
	const facts = (providers: string[], small = "p/haiku") => ({
		sessionModel: "p/opus",
		providers: providers.map((id) => ({ id, count: 2 })),
		small,
		medium: "p/sonnet",
		profiles: { researcher: `${small}:medium` },
	});

	it("says the user changed providers when no provider refused", () => {
		const watch = new RoutingWatch(() => false);
		watch.prompt(facts(["p", "q"]));
		const notice = watch.notice(facts(["p"]));
		expect(notice).toBeDefined();
		expect(notice).not.toBe(noticeFor((provider) => provider === "q", facts(["p", "q"]), facts(["p"])));
	});

	it("names a provider that refused its credential instead of a user change, and again when it recovers", () => {
		const refused = new Set<string>();
		const watch = new RoutingWatch((provider) => refused.has(provider));
		watch.prompt(facts(["p", "q"]));

		refused.add("q");
		const gone = watch.notice(facts(["p"], "p/tiny"));
		// The cause is the refusal: the same facts without one read differently.
		expect(gone).not.toBe(noticeFor(() => false, facts(["p", "q"]), facts(["p"], "p/tiny")));
		expect(gone).toContain("(no longer available: `q`)");

		refused.delete("q");
		const back = watch.notice(facts(["p", "q"]));
		expect(back).not.toBe(noticeFor(() => false, facts(["p"]), facts(["p", "q"])));
		expect(back).toContain("(added `q`)");
	});

	it("names both causes when a refusal and a user change arrive together", () => {
		const watch = new RoutingWatch((provider) => provider === "q");
		watch.prompt(facts(["p", "q", "r"]));
		const notice = watch.notice(facts(["p"]));
		// Both causes: unlike either one alone.
		const refusalOnly = noticeFor((provider) => provider === "q", facts(["p", "q", "r"]), facts(["p", "r"]));
		const userOnly = noticeFor(() => false, facts(["p", "q", "r"]), facts(["p"]));
		expect(notice).toBeDefined();
		expect(notice).not.toBe(refusalOnly);
		expect(notice).not.toBe(userOnly);
	});

	it("repeats no notice while a credential refusal outlives the routing window of a transient one", () => {
		vi.useFakeTimers();
		try {
			const health = new ProviderHealth();
			const routed = () => routingFacts([opus, other], opus, [], undefined, (provider) => health.refused(provider));
			const watch = new RoutingWatch((provider) => health.refused(provider));
			expect(routed()?.providers.map((entry) => entry.id)).toEqual(["p", "q"]);
			watch.prompt(routed());
			health.noteRun("q/mini", '401 {"error":"invalid_grant"}');
			expect(watch.notice(routed())).toContain("`q`");
			vi.advanceTimersByTime(60 * 60_000);
			expect(watch.notice(routed())).toBeUndefined();
			expect(routed()?.providers.map((entry) => entry.id)).toEqual(["p"]);
			health.credentialChanged("q");
			expect(watch.notice(routed())).toContain("`q`");
		} finally {
			vi.useRealTimers();
		}
	});

	it("names a retry.fallbackModels switch of the session model as the cause, not the user", () => {
		const before = facts(["p", "q"]);
		const after = { ...before, sessionModel: "q/mini", medium: "q/mini" };
		const switched = { from: "p/opus", to: "q/mini", reason: "hit a usage limit", billingChanged: false };
		const reading = (fallback?: typeof switched) => ({
			catalog: undefined,
			under: () => undefined,
			switched: () => fallback,
		});
		const watch = new RoutingWatch(() => false);
		watch.prompt(before);
		const notice = watch.notice(after, reading(switched));
		expect(notice).toContain("`p/opus` hit a usage limit");
		// The user's cause is the part a user switch adds before the facts; the fallback's notice has none of it.
		const userOnly = noticeFor(() => false, before, after) ?? "";
		const userCause = userOnly
			.slice(`[${ROUTING_NOTICE_ID}] `.length, userOnly.indexOf("`<delegation>`"))
			.split(". ")[0];
		expect(userOnly).toContain(userCause);
		expect(notice).not.toContain(userCause);
		// A switch to another model than the one the session runs, or none, leaves the user's cause.
		const other = new RoutingWatch(() => false);
		other.prompt(before);
		expect(other.notice(after, reading({ ...switched, to: "q/other" }))).toBe(userOnly);
	});

	it("reads the switch behind the session model from the branch: a later model choice ends it", () => {
		const choice = (provider: string, modelId: string) => ({ type: "model_change", provider, modelId }) as never;
		const data = { from: "p/opus", to: "q/mini", reason: "hit a usage limit", billingChanged: false };
		const switchEntry = { type: "custom", customType: FALLBACK_ENTRY, data } as never;
		const reply = { type: "message", message: { role: "assistant" } } as never;
		expect(latestFallback([choice("p", "opus"), choice("q", "mini"), switchEntry, reply])).toEqual(data);
		expect(latestFallback([choice("q", "mini"), switchEntry, choice("p", "opus"), reply])).toBeUndefined();
		expect(latestFallback([choice("p", "opus"), reply])).toBeUndefined();
	});

	it("gives a provider the user re-enabled the user's cause, not a recovery", () => {
		const watch = new RoutingWatch(() => false);
		watch.prompt(facts(["p"]));
		const notice = watch.notice(facts(["p", "q"]));
		expect(notice).toContain("(added `q`)");
		// Not the recovery notice of a provider whose credential was refused before.
		const refused = new Set<string>();
		const recovering = new RoutingWatch((provider) => refused.has(provider));
		recovering.prompt(facts(["p", "q"]));
		refused.add("q");
		recovering.notice(facts(["p"]));
		refused.delete("q");
		expect(notice).not.toBe(recovering.notice(facts(["p", "q"])));
	});
});

describe("coordinator prompt routing", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	it("states routes in the prompt once per session and sends a hidden notice when a command changes them", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "agent"]) fake.tools.set(name, { name });
		fake.api.tools.setActive(["bash", "file", "agent"]);
		const profiles = new Map([["researcher", researcher]]);
		const turn = registerTurnSetup(fake.api, { isSubagent: false, profiles: () => profiles });
		let available = [opus, sonnet, haiku, other];
		const ctx = {
			hasUI: true,
			model: opus,
			modelRegistry: {
				...meteredBilling,
				getProviderKind: () => "API key",
				getAvailable: () => available,
				getAll: () => available,
				isModelHidden: () => false,
			},
		};
		const start = async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {} } };
			const [result] = (await fake.emit("before_agent_start", event, ctx)) as Array<
				{ message?: { customType: string; content: string; display: boolean } } | undefined
			>;
			return { prompt: allSections(event).delegation ?? "", message: result?.message };
		};

		const first = await start();
		expect(first.prompt).toContain(
			"- Models: you run `p/opus`; providers: `p` (3), `q` (1); `small`: `p/haiku`; `medium`: `p/sonnet`.",
		);
		expect(first.prompt).toContain("  - researcher (`p/haiku:medium`): Reads code");
		expect(first.message).toBeUndefined();

		// The user disables provider q between prompts: the prompt stays, the next prompt carries one notice.
		available = [opus, sonnet, haiku];
		const second = await start();
		expect(second.prompt).toBe(first.prompt);
		expect(second.message).toMatchObject({ customType: ROUTING_NOTICE_ID, display: false });
		expect(second.message?.content).toContain("(no longer available: `q`)");
		expect((await start()).message).toBeUndefined();

		// During a run, the change arrives after the current turn.
		available = [opus, sonnet, haiku, other];
		await fake.emit("turn_end", {}, ctx);
		expect(fake.sent.at(-1)).toMatchObject({
			message: { customType: ROUTING_NOTICE_ID, display: false },
			options: { triggerTurn: false },
		});
		expect(fake.sent.at(-1)?.message.content).toContain("(added `q`)");

		// A reload states the current facts in the prompt.
		available = [opus, haiku];
		turn.reset();
		const reloaded = await start();
		expect(reloaded.prompt).toContain("providers: `p` (2); `small`: `p/haiku`");
		expect(reloaded.message).toBeUndefined();
	});

	it("sends no notice when only the models.dev index changed, and the current counts with a later registry change", async () => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", home);
		const fake = fakeHost();
		for (const name of ["bash", "file", "agent"]) fake.tools.set(name, { name });
		fake.api.tools.setActive(["bash", "file", "agent"]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		let available = [opus, sonnet, haiku, other];
		const ctx = {
			hasUI: true,
			model: opus,
			modelRegistry: {
				...meteredBilling,
				getProviderKind: () => "API key",
				getAvailable: () => available,
				getAll: () => available,
				isModelHidden: () => false,
			},
		};
		const start = async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {} } };
			const [result] = (await fake.emit("before_agent_start", event, ctx)) as Array<
				{ message?: { content: string } } | undefined
			>;
			return { prompt: allSections(event).delegation ?? "", message: result?.message };
		};

		// No saved index yet: the first prompt counts q's model as runnable.
		const first = await start();
		expect(first.prompt).toContain("providers: `p` (3), `q` (1)");

		// The refresh the session started saves an index in which q's model calls no tools.
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(
			join(home, "agent", "models-dev.json"),
			JSON.stringify({ fetchedAt: Date.now(), models: { mini: { toolCall: false } }, providers: [] }),
		);
		expect((await start()).message).toBeUndefined();
		await fake.emit("turn_end", {}, ctx);
		expect(fake.sent).toEqual([]);

		// A provider the user disables is told with the counts the new index gives.
		available = [opus, haiku, other];
		const notice = (await start()).message?.content;
		expect(notice).toContain("Providers (models that can run a task): `p` (2), `q` (0)");
		expect((await start()).message).toBeUndefined();
	});

	it("tells the coordinator after a turn that retry.fallbackModels moved its model, naming the cause", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "agent"]) fake.tools.set(name, { name });
		fake.api.tools.setActive(["bash", "file", "agent"]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const branch: unknown[] = [{ type: "model_change", provider: "p", modelId: "opus" }];
		const ctx = {
			hasUI: true,
			model: opus,
			modelRegistry: {
				...meteredBilling,
				getProviderKind: () => "API key",
				getAvailable: () => [opus, sonnet, haiku, other],
				getAll: () => [opus, sonnet, haiku, other],
				isModelHidden: () => false,
			},
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		};
		const event = { systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {} } };
		await fake.emit("before_agent_start", event, ctx);
		// The session's switch (`retry-fallback.ts`): its model choice, then the switch entry.
		branch.push({ type: "model_change", provider: "q", modelId: "mini" });
		branch.push({
			type: "custom",
			customType: FALLBACK_ENTRY,
			data: { from: "p/opus", to: "q/mini", reason: "hit a usage limit", billingChanged: true },
		});
		ctx.model = other;
		await fake.emit("turn_end", {}, ctx);
		const notice = String(fake.sent.at(-1)?.message.content);
		expect(notice).toContain("`p/opus` hit a usage limit");
		expect(notice).toContain("You run `q/mini`.");
	});
});
