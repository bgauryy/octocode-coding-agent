import fs from "node:fs";
import path from "node:path";
import {
	type Api,
	createFauxCore,
	fauxAssistantMessage,
	InMemoryModelsStore,
	type Model,
	resolveModelCapabilities,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { INSTRUCTION_CACHE_RETENTION_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { FeatureSetup, FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getPromptCacheTtlMs } from "../../src/core/cache-warmer/economics.ts";
import { PromptCacheLifetimes, promptCacheTtlMs } from "../../src/octocode/compaction/cache.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { restoreEnv } from "./e2e-headless.ts";
import { createTestSession } from "../helpers/session.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main/runtime-factory.ts";
import { tmp } from "./helpers.ts";
import { baseEnv, captureChild, fixture, withEnv, type AgentContext } from "./agent-context/capture.ts";
import { instructionBlocks, toolsText } from "./agent-context/fingerprint.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * Cache edge cases of the request a child sends (lane harness). Provider caches read the request from its start: the
 * tool array, then the first instruction block (everything before `instructionCacheBoundary`). Children of different
 * roles share both, so a researcher started after an implementer reads ~35k tokens the implementer wrote.
 */
afterAll(restoreEnv);

describe("children of different bundled roles", () => {
	const roles = [undefined, "researcher", "implementer", "reviewer"] as const;
	let contexts: AgentContext[] = [];

	it("send a byte-identical tool array and first instruction block", async () => {
		contexts = [];
		for (const role of roles) contexts.push(await captureChild(role ?? "general", role));
		const [general, ...others] = contexts;
		// Not vacuous: the read-only roles differ from each other and from the writable ones after the boundary; the
		// general child and the implementer are both writable with the same policy, so they share it.
		expect(new Set(contexts.map((context) => instructionBlocks(context).session)).size).toBe(roles.length - 1);
		expect(general.tools.length).toBeGreaterThan(5);
		expect(instructionBlocks(general).base.length).toBeGreaterThan(2_000);
		for (const other of others) {
			// Every role declares the MCP tools the same way (deferred until used), the implementer included, so all roles
			// send one byte-identical tool array and share its cache.
			expect({ role: other.role, tools: toolsText(other) }).toEqual({ role: other.role, tools: toolsText(general) });
			expect(instructionBlocks(general).base).toContain("<mcps>");
			expect({ role: other.role, base: instructionBlocks(other).base }).toEqual({
				role: other.role,
				base: instructionBlocks(general).base,
			});
		}
	}, 120_000);
});

describe("an isolated (worktree) child", () => {
	it("sends the tools and both instruction blocks of the same role started in the checkout", async () => {
		const plain = await captureChild("implementer", "implementer");
		const isolated = await captureChild("implementer", "implementer", undefined, { isolated: true });
		// Not vacuous: the task names the worktree, so the two runs really differ.
		expect(isolated.messages.at(-1)?.text).toContain("worktrees/child-example");
		expect(plain.messages.at(-1)?.text).not.toContain("worktrees/child-example");
		expect(toolsText(isolated)).toBe(toolsText(plain));
		expect(instructionBlocks(isolated)).toEqual(instructionBlocks(plain));
	}, 120_000);
});

/**
 * User decision (2026-11-08): with nothing configured, the main session and every subagent cache at the longest tier
 * on every provider. The main session resolves its requests from the settings layers (`create-session.ts`); a child's
 * pair is resolved in the parent for the child's model from the parent's settings (`subagents/claim.ts`) and reaches
 * the child process as environment variables (`subagentProcessEnv`).
 */
describe("retention with no settings", () => {
	afterEach(() => vi.unstubAllEnvs());
	const unset = () => {
		vi.stubEnv(CACHE_RETENTION_ENV, undefined);
		vi.stubEnv(INSTRUCTION_CACHE_RETENTION_ENV, undefined);
	};
	const runtime = () =>
		ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
	// Defaults: history is written every turn and read within minutes, so the short tier;
	// instructions are shared across turns, sessions and children, so the long tier.
	const DEFAULTS = { cacheRetention: "short", instructionCacheRetention: "long" };
	/** What `claim.ts` resolves for a child on `model`, and the environment its process starts with. */
	const child = (models: ModelRuntime, model: Model<Api>, parent: SettingsManager) => {
		const preferences = models.getCachePolicy(model, undefined, [
			{ source: "parent settings", values: parent.getSettings() },
		]).options;
		const env = subagentProcessEnv(undefined, {}, { id: "child-example", cachePreferences: preferences });
		return {
			preferences,
			env: { history: env[CACHE_RETENTION_ENV], instructions: env[INSTRUCTION_CACHE_RETENTION_ENV] },
			ttlMs: getPromptCacheTtlMs(model, preferences),
		};
	};

	it("is short history with long instructions for the main session and every child, on every built-in model", async () => {
		unset();
		const models = await runtime();
		const settings = SettingsManager.inMemory({});
		const providers = getBuiltinProviders();
		expect(providers.length).toBeGreaterThan(5);
		let withShort = 0;
		const lifetimes = new PromptCacheLifetimes();
		for (const provider of providers) {
			for (const model of getBuiltinModels(provider) as Model<Api>[]) {
				const id = `${provider}/${model.id}`;
				const main = models.getCachePolicy(model, undefined, settings.getCachePreferenceLayers()).options;
				expect({ id, main }).toEqual({ id, main: DEFAULTS });
				const started = child(models, model, settings);
				expect({ id, child: started.preferences }).toEqual({ id, child: DEFAULTS });
				expect({ id, env: started.env }).toEqual({ id, env: { history: "short", instructions: "long" } });
				// The child plans with the lifetime the adapter sends for short history: the model's resolved short tier.
				const short = resolveModelCapabilities(model).cache.lifetimes.short;
				if (short !== undefined) {
					withShort++;
					expect({ id, ttlMs: started.ttlMs }).toEqual({ id, ttlMs: short * 1000 });
					// Compaction (clearing, idle warming) plans with the same lifetime as the warmer.
					const compaction = promptCacheTtlMs(lifetimes.of(model), { [CACHE_RETENTION_ENV]: "short" });
					expect({ id, compaction }).toEqual({ id, compaction: short * 1000 });
				}
			}
		}
		// Not vacuous: every marker model (Anthropic, Bedrock Claude, Anthropic-protocol gateways) and OpenAI explicit mode.
		expect(withShort).toBeGreaterThan(150);
		// The gateway default, pinned both ways: Claude through a gateway without a documented 1h tier has no long tier,
		// Claude on api.anthropic.com and on OpenRouter (which documents `ttl: "1h"` for Claude) has the one-hour tier.
		const gateway = getBuiltinModel("vercel-ai-gateway", "anthropic/claude-haiku-4.5") as Model<Api>;
		expect(gateway.api).toBe("anthropic-messages");
		expect(resolveModelCapabilities(gateway).cache.lifetimes.long).toBeUndefined();
		const openRouter = getBuiltinModel("openrouter", "anthropic/claude-haiku-4.5") as Model<Api>;
		expect(resolveModelCapabilities(openRouter).cache.lifetimes.long).toBe(3600);
		const direct = getBuiltinModel("anthropic", "claude-haiku-4-5") as Model<Api>;
		expect(direct.baseUrl).toBe("https://api.anthropic.com");
		expect(resolveModelCapabilities(direct).cache.lifetimes.long).toBe(3600);
	});

	// A marker adapter sends long history on a model with no long tier at the 5m short lifetime, so the warmer and
	// compaction plan with the short tier instead of no lifetime.
	it("plans with the short tier for long history on marker models without a long tier", async () => {
		unset();
		const models = await runtime();
		const settings = SettingsManager.inMemory({});
		const lifetimes = new PromptCacheLifetimes();
		const opus41 = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0") as Model<Api>;
		expect(resolveModelCapabilities(opus41).cache).toEqual({ mechanism: "markers", lifetimes: { short: 300 } });
		expect(child(models, opus41, settings).ttlMs).toBe(300_000);
		let shortOnly = 0;
		for (const provider of getBuiltinProviders()) {
			for (const model of getBuiltinModels(provider) as Model<Api>[]) {
				const { mechanism, lifetimes: tiers } = resolveModelCapabilities(model).cache;
				if (mechanism !== "markers" || tiers.long !== undefined || tiers.short === undefined) continue;
				shortOnly++;
				const id = `${provider}/${model.id}`;
				expect({ id, ttlMs: child(models, model, settings).ttlMs }).toEqual({ id, ttlMs: tiers.short * 1000 });
				const compaction = promptCacheTtlMs(lifetimes.of(model), { [CACHE_RETENTION_ENV]: "long" });
				expect({ id, compaction }).toEqual({ id, compaction: tiers.short * 1000 });
			}
		}
		expect(shortOnly).toBeGreaterThan(0);
	});

	/** The runtime a one-shot `octocode -p` run builds (`runtime-factory.ts`), in an isolated home and project. */
	const printRuntime = async () => {
		const root = tmp("octocode-print-");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		fs.mkdirSync(agentDir);
		const factory = createCliRuntimeFactory({
			parsed: parseArgs(["-p", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "hi"]),
			cwd,
			nativeFeatures: nativeFeatureSet(),
			folderTrust: () => ({ state: "trusted", root: cwd }),
			requireTrust: false,
			getAppMode: () => "print",
			skillResourceSnapshot: undefined,
		});
		return factory({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	};

	// User decision (2026-11-08): no `--print` exception. `claim.ts` resolves a child's pair from the parent's settings,
	// session overrides included, so a print-only override would reach every child (the ship eval runs `-p`).
	it("is short history with long instructions for a one-shot `--print` run, its children and theirs", async () => {
		unset();
		const models = await runtime();
		const created = await printRuntime();
		try {
			const settings = created.services.settingsManager;
			expect(settings.getCachePreferences()).toEqual(DEFAULTS);
			for (const model of [
				getBuiltinModel("anthropic", "claude-opus-4-6"),
				getBuiltinModel("openai", "gpt-6.1-sol"),
			] as Model<Api>[]) {
				const id = `${model.provider}/${model.id}`;
				const main = models.getCachePolicy(model, undefined, settings.getCachePreferenceLayers()).options;
				expect({ id, main }).toEqual({ id, main: DEFAULTS });
				const started = child(models, model, settings);
				expect({ id, child: started.preferences }).toEqual({ id, child: DEFAULTS });
				expect({ id, env: started.env }).toEqual({ id, env: { history: "short", instructions: "long" } });
				// A grandchild resolves in the child process, whose environment carries the pair the child started with.
				vi.stubEnv(CACHE_RETENTION_ENV, started.env.history);
				vi.stubEnv(INSTRUCTION_CACHE_RETENTION_ENV, started.env.instructions);
				const grandchild = child(models, model, SettingsManager.inMemory({}));
				expect({ id, grandchild: grandchild.env }).toEqual({
					id,
					grandchild: { history: "short", instructions: "long" },
				});
				unset();
			}
		} finally {
			created.session.dispose?.();
		}
	}, 60_000);
});

const serialized = (context: TranscriptContext, count = context.messages.length) =>
	JSON.stringify(context.messages.slice(0, count));

/** True when request `next` opens with every message of request `previous`: the provider can read its cache. */
const extendsPrefix = (previous: TranscriptContext, next: TranscriptContext) =>
	next.messages.length > previous.messages.length &&
	serialized(next, previous.messages.length) === serialized(previous);

/** What `next` carries after `previous`'s messages. */
const delta = (previous: TranscriptContext, next: TranscriptContext) =>
	JSON.stringify(next.messages.slice(previous.messages.length));

/**
 * A real session on scripted models `faux/<id>` in `fx`, with `extra` registered by the same extension (a tool, as an
 * MCP server registers its tools). `prompt` records the transcript each request carried. The caller disposes it.
 */
async function scripted(
	fx: ReturnType<typeof fixture>,
	{
		ids = ["faux-1"],
		extra,
		sessionManager = SessionManager.inMemory(fx.cwd),
	}: { ids?: string[]; extra?: (api: FeatureSetup) => void; sessionManager?: SessionManager } = {},
) {
	const faux = createFauxCore({
		provider: "faux",
		models: ids.map((id) => ({ id, contextWindow: 200_000, maxTokens: 4_096 })),
	});
	let api: FeatureSetup | undefined;
	const factory: FeatureRegister = (registered) => {
		api = registered;
		registered.providers.register("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
			streamSimple: faux.streamSimple,
		} as never);
		extra?.(registered);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([{ name: "scripted", factory }]),
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		resourceLoader,
		settingsManager,
		sessionManager,
	});
	await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
	const contexts: TranscriptContext[] = [];
	const prompt = async (text: string) => {
		faux.setResponses([
			(context: TranscriptContext) => {
				contexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await session.prompt(text);
	};
	const use = (id: string) => session.setModel(session.modelRuntime.getModel("faux", id)!);
	await use(ids[0]);
	return { session, api: api!, contexts, prompt, use };
}

/** Runs `run` in a fresh fixture with its environment, then removes the fixture. */
async function inFixture(run: (fx: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
	const fx = fixture();
	try {
		await withEnv(baseEnv(fx), () => run(fx));
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

/**
 * A tool whose definition changes mid-session, as an MCP server's does when it reconnects with another schema or list:
 * the transcript is append-only, so the change rides in a system message after the history (`toolsAdded`,
 * `toolsRemoved`) and the tool array the provider read first stays as sent. On Anthropic the adapter sends that message
 * as native `tool_addition` / `tool_removal` blocks (`anthropic-cache-breakpoint-matrix.test.ts` covers the wire).
 */
describe("a tool redefined or removed mid-session", () => {
	const docsTool = (description: string) => ({
		name: "docs_search",
		label: "Docs search",
		description,
		parameters: Type.Object({ query: Type.String({ description: "What to look up" }) }),
		execute: async () => ({ content: [{ type: "text" as const, text: "found" }], details: {} }),
	});

	it("appends each change after the history and keeps every earlier request a byte-identical prefix", async () => {
		await inFixture(async (fx) => {
			const s = await scripted(fx, { extra: (api) => api.tools.register(docsTool("Search the docs server (v1).")) });
			try {
				await s.prompt("first");
				// The server reconnects with a changed description: same name, new definition.
				s.api.tools.register(docsTool("Search the docs server (v2, with filters)."));
				await s.prompt("second");
				// The server drops the tool.
				s.session.setActiveToolsByName(s.session.getActiveToolNames().filter((name) => name !== "docs_search"));
				await s.prompt("third");
				expect(s.contexts).toHaveLength(3);
				expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
				expect(extendsPrefix(s.contexts[1], s.contexts[2])).toBe(true);
				// Not vacuous: each change is in the delta, and the first request carried v1 alone.
				expect(serialized(s.contexts[0])).toContain("(v1)");
				expect(serialized(s.contexts[0])).not.toContain("(v2");
				expect(delta(s.contexts[0], s.contexts[1])).toContain("toolsAdded");
				expect(delta(s.contexts[0], s.contexts[1])).toContain("(v2, with filters)");
				// The scripted model's transport has no in-place tool changes: the removal is announced and held, so the tool
				// list the provider read stays as sent until the next span.
				expect(delta(s.contexts[1], s.contexts[2])).not.toContain("toolsRemoved");
				expect(delta(s.contexts[1], s.contexts[2])).toContain("docs_search is turned off");
			} finally {
				s.session.dispose?.();
			}
		});
	});
});

/**
 * A provider caches per model, so a switch starts the other model cold; switching back must find the first model's
 * entries still a prefix of the transcript, which only holds when the switch rewrites nothing that was sent.
 */
describe("a model switch and back", () => {
	it("keeps every request a prefix of the next, so the first model reads its own entries again", async () => {
		await inFixture(async (fx) => {
			const s = await scripted(fx, { ids: ["faux-1", "faux-2"] });
			try {
				await s.prompt("first");
				await s.use("faux-2");
				await s.prompt("second");
				await s.use("faux-1");
				await s.prompt("third");
				expect(s.contexts).toHaveLength(3);
				expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
				expect(extendsPrefix(s.contexts[1], s.contexts[2])).toBe(true);
			} finally {
				s.session.dispose?.();
			}
		});
	});
});

/** A fork continues the parent's transcript: its first request opens with what the parent last sent and received. */
describe("a fork", () => {
	it("sends the parent's last request and reply as the prefix of its first request", async () => {
		await inFixture(async (fx) => {
			const dir = path.join(fx.root, "sessions");
			const parent = await scripted(fx, { sessionManager: SessionManager.create(fx.cwd, dir) });
			let forkPath: string | undefined;
			try {
				await parent.prompt("first");
				await parent.prompt("second");
				const manager = parent.session.sessionManager;
				forkPath = manager.createBranchedSession(manager.getLeafId()!);
			} finally {
				parent.session.dispose?.();
			}
			expect(forkPath).toBeDefined();
			const fork = await scripted(fx, { sessionManager: SessionManager.open(forkPath!, dir, fx.cwd) });
			try {
				await fork.prompt("third");
				expect(fork.contexts).toHaveLength(1);
				expect(extendsPrefix(parent.contexts[1], fork.contexts[0])).toBe(true);
			} finally {
				fork.session.dispose?.();
			}
		});
	});
});
