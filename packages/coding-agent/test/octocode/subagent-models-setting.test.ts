import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { MODELS_DEV_ENV } from "../../src/core/model-catalog/index-store.ts";
import { configuredSubagentModels } from "../../src/octocode/subagents/configured-models.ts";
import { type ModelRef, type Refused, routeModel } from "../../src/octocode/subagents/model.ts";
import { routingFacts } from "../../src/octocode/subagents/models-command.ts";
import { registerModelsTool } from "../../src/octocode/native/tools/models/tool.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { meteredBilling, asSetup } from "./fake-host.ts";

const model = (provider: string, id: string, input: number, output: number, extra: object = {}): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
	reasoning: true,
	...extra,
});
const parent = model("home", "big", 10, 40);
const cheap = model("cheap", "tiny", 0.1, 0.4);
const mid = model("other", "mid", 4, 16);
const pick = model("pick", "chosen", 1, 4);
const available = [parent, cheap, mid, pick];
const configured = { small: "pick/chosen:high" };

describe("subagents.models: routing precedence", () => {
	it("uses the setting for a purpose, with its own level, before the automatic choice", () => {
		expect(routeModel({ preferred: "small", available, parent, configured })).toEqual({
			model: "pick/chosen:high",
			setting: "subagents.models.small",
			fallbackModels: ["cheap/tiny:high", "other/mid:high"],
		});
		// A bare id resolves like a call's model, and without a level the default level applies.
		expect(
			routeModel({ preferred: "small", available, parent, configured: { small: "chosen" }, thinking: "low" }),
		).toEqual({
			model: "pick/chosen:low",
			setting: "subagents.models.small",
			fallbackModels: ["cheap/tiny:low", "other/mid:low"],
		});
		// The automatic choice when nothing is set.
		expect(routeModel({ preferred: "small", available, parent })).toEqual({
			model: "cheap/tiny",
			fallbackModels: ["pick/chosen", "other/mid"],
		});
	});

	it("keeps the purpose's own level over the setting's, and a call's model over the setting", () => {
		expect(routeModel({ preferred: "small:low", available, parent, configured })).toMatchObject({
			model: "pick/chosen:low",
		});
		expect(routeModel({ explicit: "other/mid", preferred: "small", available, parent, configured })).toEqual({
			model: "other/mid",
		});
		expect(
			routeModel({ explicit: "medium", available, parent, configured: { medium: "other/mid:off" } }),
		).toMatchObject({
			model: "other/mid:off",
		});
	});

	it("falls back to the automatic choice, saying why, when the set model is unavailable, refused or cannot run a task", () => {
		const auto = { model: "cheap/tiny", fallbackModels: ["pick/chosen", "other/mid"] };
		expect(routeModel({ preferred: "small", available, parent, configured: { small: "pick/gone" } })).toEqual({
			...auto,
			skipped: "subagents.models.small pick/gone unavailable",
		});
		const refused: Refused = (provider) => provider === "pick";
		expect(routeModel({ preferred: "small", available, parent, configured, refused })).toEqual({
			...auto,
			// The refused provider is no fallback either.
			fallbackModels: ["other/mid"],
			skipped: "subagents.models.small pick/chosen: pick refused its credential".replace("pick/chosen", "pick/chosen"),
		});
		const small = model("pick", "chosen", 1, 4, { contextWindow: 8_192 });
		expect(routeModel({ preferred: "small", available: [parent, cheap, small], parent, configured })).toMatchObject({
			model: "pick/chosen:high",
			setting: "subagents.models.small",
		});
	});

	it("keeps a free model of a provider that is out of funds", () => {
		const free = model("pick", "chosen", 0, 0);
		const outOfFunds: Refused = (_provider, _id, _proven, cost) => !cost || cost.input + cost.output > 0;
		expect(
			routeModel({ preferred: "small", available: [parent, cheap, free], parent, configured, refused: outOfFunds }),
		).toMatchObject({ model: "pick/chosen:high", setting: "subagents.models.small" });
	});
});

describe("subagents.models: the global setting and its surfaces", () => {
	let dir: string;
	const saved = { agent: process.env[ENV_AGENT_DIR], dev: process.env[MODELS_DEV_ENV] };
	const write = (models: object) =>
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ subagents: { models } }));
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-subagent-models-"));
		process.env[ENV_AGENT_DIR] = dir;
		process.env[MODELS_DEV_ENV] = "0";
	});
	afterEach(() => {
		for (const [key, value] of [
			[ENV_AGENT_DIR, saved.agent],
			[MODELS_DEV_ENV, saved.dev],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reads the global file, ignoring blank values", () => {
		expect(configuredSubagentModels(dir)).toEqual({});
		write({ small: " pick/chosen:low ", medium: "" });
		expect(configuredSubagentModels(dir)).toEqual({ small: "pick/chosen:low" });
	});

	it("reaches profiles that name a purpose, and says so in the route", () => {
		write({ small: "pick/chosen:high" });
		const profiles = loadProfiles(dir, dir, false, {});
		const ctx = {
			modelRegistry: { ...meteredBilling, getAvailable: () => available, getProvider: () => undefined },
			model: parent,
		} as never;
		const researcher = planRun(profiles, { profile: "researcher" }, ctx).route;
		// The profile says `small:medium`: its own level outranks the setting's.
		expect(researcher.model).toBe("pick/chosen:medium");
		expect(researcher.via).toBe("profile researcher: small:medium; setting subagents.models.small");
		expect(planRun(profiles, { profile: "researcher", model: "other/mid" }, ctx).route.model).toBe("other/mid:medium");
		write({ small: "pick/gone" });
		expect(planRun(profiles, { profile: "lean" }, ctx).route.via).toBe(
			"profile lean: small:low; automatic; subagents.models.small pick/gone unavailable",
		);
	});

	it("shows the configured value and its source in the routing facts and the models tool", async () => {
		write({ small: "pick/chosen:high", medium: "pick/gone" });
		const facts = routingFacts(available, parent, [], undefined, () => false);
		expect(facts?.small).toBe("pick/chosen:high (setting subagents.models.small)");
		expect(facts?.medium).toContain("(automatic; subagents.models.medium pick/gone unavailable)");

		let tool: ToolDefinition | undefined;
		registerModelsTool(
			asSetup({
				registerTool: (definition: ToolDefinition) => void (tool = definition),
				// The quota notice registers with the tool (`models-quota-notice.ts`); no event fires here.
				on: () => () => undefined,
			}) as never,
			() => new Map(),
		);
		const result = await tool!.execute("c", { routes: true }, undefined, undefined, {
			model: parent,
			thinkingLevel: "low",
			modelRegistry: {
				...meteredBilling,
				getAvailable: () => available,
				getAll: () => available,
				find: () => undefined,
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			},
		} as never);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("  small: pick/chosen:high (setting subagents.models.small)");
		expect(text).toContain("(automatic; subagents.models.medium pick/gone unavailable)");
	});
});
