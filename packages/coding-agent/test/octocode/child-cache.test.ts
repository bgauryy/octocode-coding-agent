import { INSTRUCTION_CACHE_RETENTION_ENV, PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { describe, expect, it } from "vitest";
import { CACHE_RETENTION_ENV } from "../../../common/src/env.ts";
import { CACHE_GROUP_ENTRY } from "../../src/octocode/shared/cache-group-entry.ts";
import { prefixHash, registerCacheGroup } from "../../src/octocode/subagents/cache-group.ts";
import { childCachePreferences, subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { AGENT_ID_ENV } from "../../src/octocode/team/store/env.ts";
import { resolveConfiguredCache } from "../../src/core/cache-configuration.ts";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";

const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");

/** What `claim.ts` resolves for a child, then the environment the child process starts with. */
function childEnv(settings: Record<string, unknown>, lingers: boolean, base: NodeJS.ProcessEnv = {}) {
	const policy = resolveConfiguredCache(model, undefined, {}, [{ source: "parent settings", values: settings }]);
	const env = subagentProcessEnv(undefined, base, {
		id: "kid",
		cachePreferences: childCachePreferences(policy, lingers),
	});
	return { history: env[CACHE_RETENTION_ENV], instructions: env[INSTRUCTION_CACHE_RETENTION_ENV], env };
}

describe("child cache retention", () => {
	it("a child that does not linger takes short history with long instructions by default", () => {
		expect(childEnv({}, false)).toMatchObject({ history: "short", instructions: "long" });
	});

	it("a lingering or resumed child keeps the long default", () => {
		expect(childEnv({}, true)).toMatchObject({ history: "long", instructions: "long" });
	});

	it("an explicit cacheRetention wins, for a child that does not linger", () => {
		expect(childEnv({ cacheRetention: "long" }, false)).toMatchObject({ history: "long", instructions: "long" });
		expect(childEnv({ cacheRetention: "none" }, false)).toMatchObject({ history: "none", instructions: "none" });
		expect(childEnv({ cacheRetention: "short" }, false)).toMatchObject({ history: "short", instructions: "short" });
	});

	it("an explicit instruction setting alone leaves history on the child default", () => {
		expect(childEnv({ instructionCacheRetention: "short" }, false)).toMatchObject({
			history: "short",
			instructions: "short",
		});
	});

	it("children ask the provider for miss reasons unless the user chose otherwise", () => {
		expect(childEnv({}, false).env.OCTOCODE_CACHE_DIAGNOSTICS).toBe("on");
		expect(childEnv({}, false, { OCTOCODE_CACHE_DIAGNOSTICS: "off" }).env.OCTOCODE_CACHE_DIAGNOSTICS).toBe("off");
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
