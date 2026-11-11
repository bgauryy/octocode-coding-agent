import { INSTRUCTION_CACHE_RETENTION_ENV, PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { describe, expect, it } from "vitest";
import { CACHE_RETENTION_ENV } from "../../../common/src/env.ts";
import { CACHE_GROUP_ENTRY } from "../../src/octocode/shared/cache-group-entry.ts";
import { prefixHash, registerCacheGroup } from "../../src/octocode/subagents/cache-group.ts";
import {
	type CacheChoice,
	childCachePreferences,
	subagentProcessEnv,
} from "../../src/octocode/subagents/process/env.ts";
import { AGENT_ID_ENV } from "../../src/octocode/team/store/env.ts";
import { resolveConfiguredCache } from "../../src/core/cache-configuration.ts";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";

const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");

/** What `claim.ts` resolves for a child whose task's tier is `choice`, then the environment the child process starts with. */
function childEnv(settings: Record<string, unknown>, choice: CacheChoice = "long", base: Record<string, string> = {}) {
	const policy = resolveConfiguredCache(model, undefined, { env: base }, [
		{ source: "parent settings", values: settings },
	]);
	const env = subagentProcessEnv(undefined, base, {
		id: "kid",
		cachePreferences: childCachePreferences(policy, choice),
	});
	return { history: env[CACHE_RETENTION_ENV], instructions: env[INSTRUCTION_CACHE_RETENTION_ENV], env };
}

describe("child cache retention", () => {
	// Owner decision (2026-11-11): the task's tier sets the child's history; the long tier costs more to write.
	it("a long task takes the session's long history and long instructions", () => {
		expect(childEnv({}, "long")).toMatchObject({ history: "long", instructions: "long" });
	});

	it("a short task takes short history and keeps the session's instruction tier", () => {
		expect(childEnv({}, "short")).toMatchObject({ history: "short", instructions: "long" });
	});

	it("the child's pair is the session policy unchanged for a long task, and whenever the user configured a retention", () => {
		for (const settings of [{}, { cacheRetention: "short" }, { instructionCacheRetention: "short" }] as const) {
			const policy = resolveConfiguredCache(model, undefined, {}, [{ source: "parent settings", values: settings }]);
			expect(childCachePreferences(policy, "long")).toEqual(policy.options);
		}
		for (const settings of [
			{ cacheRetention: "long" },
			{ cacheRetention: "short" },
			{ cacheRetention: "none" },
		] as const) {
			const policy = resolveConfiguredCache(model, undefined, {}, [{ source: "parent settings", values: settings }]);
			expect(childCachePreferences(policy, "short")).toEqual(policy.options);
		}
	});

	it("an explicit cacheRetention setting wins over either task tier", () => {
		for (const choice of ["short", "long"] as const) {
			expect(childEnv({ cacheRetention: "long" }, choice)).toMatchObject({ history: "long", instructions: "long" });
			expect(childEnv({ cacheRetention: "none" }, choice)).toMatchObject({ history: "none", instructions: "none" });
			expect(childEnv({ cacheRetention: "short" }, choice)).toMatchObject({
				history: "short",
				instructions: "short",
			});
		}
	});

	it("an explicit environment retention wins", () => {
		expect(childEnv({}, "long", { [CACHE_RETENTION_ENV]: "short" })).toMatchObject({ history: "short" });
		expect(childEnv({}, "short", { [CACHE_RETENTION_ENV]: "long" })).toMatchObject({ history: "long" });
		expect(childEnv({ cacheRetention: "long" }, "long", { [CACHE_RETENTION_ENV]: "short" })).toMatchObject({
			history: "short",
		});
	});

	it("an explicit instruction setting alone leaves history to the task's tier", () => {
		expect(childEnv({ instructionCacheRetention: "short" }, "long")).toMatchObject({
			history: "long",
			instructions: "short",
		});
		expect(childEnv({ instructionCacheRetention: "short" }, "short")).toMatchObject({
			history: "short",
			instructions: "short",
		});
	});

	it("children ask the provider for miss reasons unless the user chose otherwise", () => {
		expect(childEnv({}).env.OCTOCODE_CACHE_DIAGNOSTICS).toBe("on");
		expect(childEnv({}, "long", { OCTOCODE_CACHE_DIAGNOSTICS: "off" }).env.OCTOCODE_CACHE_DIAGNOSTICS).toBe("off");
	});
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function session(env: NodeJS.ProcessEnv) {
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const handlers = new Map<string, Handler>();
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		getActiveTools: () => ["bash"],
		getAllTools: () => [
			{ name: "bash", description: "run", parameters: {} },
			{ name: "file", description: "edit", parameters: {} },
		],
	};
	registerCacheGroup(api as never, env);
	const ctx = { sessionManager: { getBranch: () => branch } };
	return { branch, start: (systemPrompt: string) => handlers.get("before_agent_start")?.({ systemPrompt }, ctx) };
}

describe("child cache group record", () => {
	it("records the cache key and prefix hash once per distinct prefix", async () => {
		const child = session({ [AGENT_ID_ENV]: "kid", [PROMPT_CACHE_KEY_ENV]: "group-1" });
		await child.start("system");
		await child.start("system");
		expect(child.branch).toEqual([
			{
				type: "custom",
				customType: CACHE_GROUP_ENTRY,
				data: {
					version: 1,
					prefix: prefixHash("system", [{ name: "bash", description: "run", parameters: {} }]),
					key: "group-1",
				},
			},
		]);
		await child.start("system changed");
		expect(child.branch).toHaveLength(2);
	});

	it("records nothing outside a subagent", async () => {
		const main = session({});
		await main.start("system");
		expect(main.branch).toEqual([]);
	});
});
