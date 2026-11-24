import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { INSTRUCTION_CACHE_RETENTION_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { describe, expect, it } from "vitest";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { resolveConfiguredCache } from "../../src/core/cache-configuration.ts";
import { sessionChildren } from "../../src/octocode/child-sessions/session-children.ts";
import { childHookMode, type HookMode, sessionHookMode } from "../../src/octocode/shared/hook-mode.ts";
import { agentToolSpec } from "../../src/octocode/native/tools/agent/spec.ts";
import { type AgentRuns, claimRun, type RunPlan, Slots, swarmLimits } from "../../src/octocode/subagents/claim.ts";
import { type CacheChoice, defaultTaskCache, subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { type AgentProfile, parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
const ROUTE = `${model.provider}/${model.id}`;

type Task = Parameters<typeof claimRun>[2];

/** `claimRun` as `spawn.ts` calls it, then the environment the child process starts with. */
function start(
	task: Partial<Task> = {},
	options: {
		profile?: Partial<AgentProfile>;
		settings?: Record<string, unknown>;
		env?: Record<string, string>;
		thinking?: string;
		resumed?: Parameters<typeof claimRun>[5];
	} = {},
) {
	const runs = {
		api: asSetup({ getSettings: () => options.settings ?? {} }),
		team: { join: () => ({ id: "parent" }), newName: () => "kid", rememberFinished: () => {} },
		running: new Map(),
		items: new Map(),
		slots: new Slots(),
		limits: swarmLimits(options.env ?? {}),
	} as unknown as AgentRuns;
	const ctx = {
		cwd: tmp("task-options-"),
		sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined },
		model,
		modelRegistry: {
			getAvailable: () => [model],
			getCachePolicy: (child: typeof model, layers: Parameters<typeof resolveConfiguredCache>[3]) =>
				resolveConfiguredCache(child, undefined, { env: options.env ?? {} }, layers),
		},
	} as unknown as Parameters<typeof claimRun>[3];
	const profile: AgentProfile | undefined = options.profile
		? { name: "worker", description: "", prompt: "", ...options.profile }
		: undefined;
	const plan: RunPlan = { profile, route: { model: options.thinking ? `${ROUTE}:${options.thinking}` : ROUTE } };
	const run = claimRun(runs, plan, { goal: "g", ...task }, ctx, [], options.resumed);
	const env = subagentProcessEnv(profile, options.env ?? {}, run.identity);
	return {
		run,
		runs,
		hooks: env.OCTOCODE_SUBAGENT_HOOKS,
		history: env[CACHE_RETENTION_ENV],
		instructions: env[INSTRUCTION_CACHE_RETENTION_ENV],
	};
}

describe("a resumed subagent's backlog item", () => {
	it("links the item again, as the run started for it did", () => {
		const resumed = { id: "kid", role: "general", sessionId: "s1", goal: "g", item: "B7" } as Parameters<
			typeof claimRun
		>[5];
		const { runs } = start({}, { resumed });
		expect(runs.items.get("kid")).toBe("B7");
		expect(start().runs.items.size).toBe(0);
	});
});

describe("a subagent's hook mode", () => {
	it.each<[profile: HookMode | undefined, task: HookMode | undefined, started: HookMode | undefined, mode: HookMode]>([
		[undefined, undefined, undefined, "off"],
		[undefined, "decisions", undefined, "decisions"],
		[undefined, "all", undefined, "all"],
		["decisions", undefined, undefined, "decisions"],
		["all", undefined, undefined, "all"],
		// The task wins over a profile that turned hooks on.
		["all", "decisions", undefined, "decisions"],
		["decisions", "off", undefined, "off"],
		// A profile's explicit false forbids hooks, whatever the task or an earlier run chose.
		["off", "all", undefined, "off"],
		["off", "decisions", "all", "off"],
		// A resumed child keeps the mode it started with unless the call names one.
		[undefined, undefined, "decisions", "decisions"],
		["all", undefined, "decisions", "decisions"],
		[undefined, "all", "decisions", "all"],
	])("profile %s, task %s, started %s → %s", (profile, task, started, mode) => {
		expect(childHookMode(profile, task, started)).toBe(mode);
	});

	it("reads a profile's hooks front matter: false/off, decisions, true/all", () => {
		const hooks = (value: string) => parseProfile("x", `---\nhooks: ${value}\n---\nbody`).hooks;
		expect(parseProfile("x", "---\ndescription: d\n---\nbody").hooks).toBeUndefined();
		expect(hooks("false")).toBe("off");
		expect(hooks('"off"')).toBe("off");
		expect(hooks("decisions")).toBe("decisions");
		expect(hooks("true")).toBe("all");
		expect(hooks("all")).toBe("all");
		expect(() => hooks("sometimes")).toThrow(/hooks must be false, off, decisions, true or all/);
	});

	it("a child runs no hook by default: nothing is put in its environment", () => {
		const child = start();
		expect(child.run.identity.hooks).toBe("off");
		expect(child.hooks).toBeUndefined();
		expect(sessionHookMode({ OCTOCODE_SUBAGENT: "1" })).toBe("off");
	});

	it("the profile and the task each select a mode, which reaches the child", () => {
		expect(start({}, { profile: { hooks: "decisions" } }).hooks).toBe("decisions");
		expect(start({}, { profile: { hooks: "all" } }).hooks).toBe("all");
		expect(start({ hooks: "decisions" }).hooks).toBe("decisions");
		expect(start({ hooks: "all" }, { profile: {} }).hooks).toBe("all");
		expect(start({ hooks: "decisions" }, { profile: { hooks: "all" } }).hooks).toBe("decisions");
		for (const mode of ["decisions", "all"] as const)
			expect(sessionHookMode({ OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: start({ hooks: mode }).hooks })).toBe(
				mode,
			);
	});

	it("a profile's explicit false wins over the task", () => {
		const child = start({ hooks: "all" }, { profile: { hooks: "off" } });
		expect(child.run.identity.hooks).toBe("off");
		expect(child.hooks).toBeUndefined();
	});

	it("a follow-up to a reachable child keeps the mode it started with", () => {
		const first = start({ hooks: "decisions" });
		expect(start({}, { resumed: first.run.identity }).hooks).toBe("decisions");
		expect(start({ hooks: "all" }, { resumed: first.run.identity }).hooks).toBe("all");
	});

	it("a resume call finds the mode an earlier call named in the session's record", () => {
		const call = (id: string, args: Record<string, unknown>) => [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id, name: "agent", arguments: { type: "task", task: "t", ...args } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent",
					toolCallId: id,
					details: { id: "kid", profile: "general", goal: "g", status: "done" },
				},
			},
		];
		const started = call("c1", { hooks: "decisions" });
		expect(sessionChildren(started)[0]?.hooks).toBe("decisions");
		// A resume that names none keeps it; one that names another replaces it.
		expect(sessionChildren([...started, ...call("c2", { resume: "kid" })])[0]?.hooks).toBe("decisions");
		expect(sessionChildren([...started, ...call("c3", { resume: "kid", hooks: "off" })])[0]?.hooks).toBe("off");
	});

	it("an inherited variable never turns hooks on for a child", () => {
		expect(subagentProcessEnv(undefined, { OCTOCODE_SUBAGENT_HOOKS: "all" })).not.toHaveProperty(
			"OCTOCODE_SUBAGENT_HOOKS",
		);
	});
});

describe("a subagent's cache tier", () => {
	it.each<[shape: Parameters<typeof defaultTaskCache>[0], tier: CacheChoice]>([
		// A child that works without pauses asks again within the short window.
		[{}, "short"],
		[{ thinking: "off" }, "short"],
		[{ thinking: "low" }, "short"],
		[{ thinking: "medium" }, "short"],
		[{ requests: 160 }, "short"],
		[{ requests: 40 }, "short"],
		[{ lingers: false, resumed: false, requests: 160 }, "short"],
		// Expected to idle past the short window: messaged after it ends, resumed, thinking hard, or a long budget.
		[{ lingers: true }, "long"],
		[{ resumed: true }, "long"],
		[{ thinking: "high" }, "long"],
		[{ thinking: "xhigh" }, "long"],
		[{ thinking: "max" }, "long"],
		[{ requests: 161 }, "long"],
		[{ requests: 0 }, "long"],
		[{ resumed: true, thinking: "low" }, "long"],
	])("%j → %s", (shape, tier) => {
		expect(defaultTaskCache(shape)).toBe(tier);
	});

	it("the default follows the task's shape", () => {
		expect(start()).toMatchObject({ history: "short", instructions: "long" });
		// Background or isolated work runs without pauses: the measured gaps sit inside the short window.
		expect(start({ background: true })).toMatchObject({ history: "short", instructions: "long" });
		expect(start({ isolate: true })).toMatchObject({ history: "short", instructions: "long" });
		expect(start({}, { thinking: "high" })).toMatchObject({ history: "long", instructions: "long" });
		expect(start({}, { thinking: "low" })).toMatchObject({ history: "short", instructions: "long" });
		// A lingering profile: only a background run that is not isolated stays reachable for a follow-up.
		expect(start({ background: true }, { profile: { linger: 300 } })).toMatchObject({ history: "long" });
		expect(start({}, { profile: { linger: 300 } })).toMatchObject({ history: "short" });
		expect(start({ background: true, isolate: true }, { profile: { linger: 300 } })).toMatchObject({
			history: "short",
		});
		expect(start({ background: true }, { env: { OCTOCODE_SUBAGENT_LINGER_SECONDS: "600" } })).toMatchObject({
			history: "long",
		});
		// A long request budget: the profile's, else the environment's.
		expect(start({}, { profile: { maxRequests: 400 } })).toMatchObject({ history: "long" });
		expect(start({}, { profile: { maxRequests: 0 } })).toMatchObject({ history: "long" });
		expect(start({}, { profile: { maxRequests: 40 } })).toMatchObject({ history: "short" });
		// A continued child: by name (`resume`) or by its kept identity (a message to a reachable one).
		expect(start({ name: "kid" })).toMatchObject({ history: "long", instructions: "long" });
		expect(start({}, { resumed: start().run.identity })).toMatchObject({ history: "long", instructions: "long" });
	});

	it("the task field overrides the default", () => {
		expect(start({ cache: "long" })).toMatchObject({ history: "long", instructions: "long" });
		expect(start({ background: true, cache: "short" }, { profile: { linger: 300 } })).toMatchObject({
			history: "short",
			instructions: "long",
		});
		expect(start({ cache: "short" }, { thinking: "max" })).toMatchObject({ history: "short", instructions: "long" });
	});

	it("a retention the user configured wins over the default and the task field", () => {
		// Settings.
		expect(start({}, { settings: { cacheRetention: "long" } })).toMatchObject({ history: "long" });
		expect(start({ cache: "short" }, { settings: { cacheRetention: "long" } })).toMatchObject({ history: "long" });
		expect(start({ cache: "long" }, { settings: { cacheRetention: "short" } })).toMatchObject({
			history: "short",
			instructions: "short",
		});
		expect(start({ cache: "long" }, { settings: { cacheRetention: "none" } })).toMatchObject({ history: "none" });
		// Environment.
		expect(start({ cache: "short" }, { env: { [CACHE_RETENTION_ENV]: "long" } })).toMatchObject({ history: "long" });
		expect(start({ name: "kid" }, { env: { [CACHE_RETENTION_ENV]: "short" } })).toMatchObject({
			history: "short",
		});
		// An instruction setting alone leaves the history to the task.
		expect(start({ cache: "short" }, { settings: { instructionCacheRetention: "short" } })).toMatchObject({
			history: "short",
			instructions: "short",
		});
	});

	it("siblings share their instruction-block settings whatever tier each chose", () => {
		const short = start({ cache: "short" });
		const long = start({ cache: "long" });
		const defaulted = start();
		expect(new Set([short.instructions, long.instructions, defaulted.instructions])).toEqual(new Set(["long"]));
		// Siblings with the same choice start with the same pair.
		const again = start({ cache: "short" });
		expect([again.history, again.instructions]).toEqual([short.history, short.instructions]);
		expect(short.run.identity.cacheTtlMs).toBeLessThan(long.run.identity.cacheTtlMs!);
	});
});

describe("the agent tool's task fields", () => {
	it("declares hooks and cache as enums with one short clause each", () => {
		const { hooks, cache } = agentToolSpec().parameters.properties as unknown as Record<
			string,
			{ enum: string[]; description: string }
		>;
		expect(hooks.enum).toEqual(["off", "decisions", "all"]);
		expect(cache.enum).toEqual(["short", "long"]);
		for (const field of [hooks, cache]) {
			expect(field.description.length).toBeLessThanOrEqual(45);
		}
	});
});
