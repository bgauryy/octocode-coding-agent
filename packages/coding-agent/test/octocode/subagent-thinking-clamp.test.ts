import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { clampNote, type ModelRef, routeSummary } from "../../src/octocode/subagents/model.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { agentToolSpec } from "../../src/octocode/subagents/agent-tool.ts";
import { meteredBilling } from "./fake-host.ts";

const model = (id: string, input: number, extra: object = {}): ModelRef =>
	({
		provider: "p",
		id,
		cost: { input, output: input * 4 },
		contextWindow: 200_000,
		reasoning: true,
		...extra,
	}) as ModelRef;
// `beam-free` cannot turn thinking off or run minimal, as opencode-go's model does.
const beam = model("beam-free", 0.1, { thinkingLevelMap: { off: null, minimal: null } });
const big = model("big", 10);
const available = [big, beam];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "octocode-clamp-"));
const ctx = {
	modelRegistry: { ...meteredBilling, getAvailable: () => available, getProvider: () => undefined },
	model: big,
} as never;

describe("the run line says when a thinking level was clamped", () => {
	const profiles = loadProfiles(tmp(), tmp(), false, {});

	it("names the asked level and that the model lacks it, for a call and for a profile or purpose", () => {
		const call = planRun(profiles, { profile: "lean", model: "p/beam-free:off" }, ctx).route;
		expect(call.model).toBe("p/beam-free:low");
		expect(call.via).toBe("model argument: p/beam-free:off; asked off; this model does not support off");
		expect(routeSummary(call)).toBe(
			"p/beam-free, low thinking (model argument: p/beam-free:off; asked off; this model does not support off)",
		);
		// A purpose's own level clamps the same way, with the same words.
		const purpose = planRun(profiles, { model: "small:minimal" }, ctx).route;
		expect(purpose.model).toBe("p/beam-free:low");
		expect(purpose.via).toBe("model argument: small:minimal; asked minimal; this model does not support minimal");
	});

	it("stays silent when the level holds", () => {
		expect(planRun(profiles, { profile: "lean", model: "p/beam-free:low" }, ctx).route.via).toBe(
			"model argument: p/beam-free:low",
		);
		expect(clampNote("p/m:low", "p/m:low")).toBe("");
		expect(clampNote("p/m", "p/m")).toBe("");
	});
});

describe("the models tool", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[MODELS_DEV_ENV];
		process.env[MODELS_DEV_ENV] = "0";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[MODELS_DEV_ENV];
		else process.env[MODELS_DEV_ENV] = saved;
	});

	const register = () => {
		const tools: ToolDefinition[] = [];
		registerModelsTool(
			{ registerTool: (definition: ToolDefinition) => void tools.push(definition) } as never,
			() => new Map(),
		);
		return tools[0];
	};
	const run = async (params: Record<string, unknown>) => {
		const result = await register().execute("c", params, undefined, undefined, {
			model: big,
			thinkingLevel: "low",
			modelRegistry: {
				...meteredBilling,
				getAvailable: () => available,
				getAll: () => available,
				find: () => undefined,
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			},
		} as never);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	};

	it("lists each model's supported thinking levels", async () => {
		const text = await run({ provider: "p" });
		const lines = text.split("\n");
		expect(lines.find((line) => line.includes("p/beam-free"))).toContain(" · thinking low/medium/high");
		expect(lines.find((line) => line.includes("● p/big ·"))).toContain("thinking off/minimal/low/medium/high");
	});

	it("offers the suffixes the agent tool accepts", async () => {
		const description = JSON.stringify(agentToolSpec().parameters);
		const accepted = /optional ((?::?\w+\|?)+)\./
			.exec(description)?.[1]
			?.split("|")
			.map((level) => level.replace(":", ""));
		const footer = /append (.*) to set its thinking/.exec(await run({ provider: "p" }))?.[1];
		expect(accepted).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(footer?.replaceAll(":", "").replace(" or ", ", ").split(", ")).toEqual(accepted);
	});
});
