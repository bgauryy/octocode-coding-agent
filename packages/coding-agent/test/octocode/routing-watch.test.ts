import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { routingFacts } from "../../src/octocode/subagents/models-command.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { ROUTING_NOTICE_ID, RoutingWatch } from "../../src/octocode/subagents/routing-watch.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost, meteredBilling } from "./fake-host.ts";
import { allSections, tmp } from "./helpers.ts";

// `reasoning` lets a profile's thinking level stand (`supportedThinking`); it is a registry field ModelRef leaves out.
const m = (provider: string, id: string, input: number, output: number): ModelRef =>
	({
		provider,
		id,
		cost: { input, output },
		contextWindow: 200_000,
		input: ["text", "image"],
		reasoning: true,
	}) as ModelRef;
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
		expect(notice).toContain("`models` with `provider` set to an id lists that provider's models.");
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

describe("coordinator prompt routing", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	it("states routes in the prompt once per session and sends a hidden notice when a command changes them", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "agent"]) fake.tools.set(name, { name });
		fake.api.setActiveTools(["bash", "file", "agent"]);
		const profiles = new Map([["researcher", researcher]]);
		const turn = registerTurnSetup(fake.api, { isSubagent: false, profiles: () => profiles });
		let available = [opus, sonnet, haiku, other];
		const ctx = {
			hasUI: true,
			model: opus,
			modelRegistry: { ...meteredBilling, getProviderKind: () => "API key", getAvailable: () => available },
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
			"- Models: you run `p/opus`; providers: `p` (3), `q` (1); `small`: `p/haiku`; `medium`: `p/sonnet` (default)",
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
		fake.api.setActiveTools(["bash", "file", "agent"]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		let available = [opus, sonnet, haiku, other];
		const ctx = {
			hasUI: true,
			model: opus,
			modelRegistry: { ...meteredBilling, getProviderKind: () => "API key", getAvailable: () => available },
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
});
