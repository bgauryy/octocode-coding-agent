import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionFromServices } from "../src/core/agent-session/create-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { formatNoModelsAvailableMessage } from "../src/core/auth-guidance.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const make = (provider: string, id: string): Model<"openai-completions"> => ({
	id,
	name: id,
	provider,
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
});

type Runtime = Parameters<typeof findInitialModel>[0]["modelRuntime"];

/** A runtime whose saved default fails one check; `beta/model` is the only available model. */
function runtimeWith(
	facts: {
		known?: boolean;
		off?: boolean;
		paused?: string;
		authed?: boolean;
		inCatalog?: boolean;
		hidden?: boolean;
		plan?: readonly string[];
	} = {},
): Runtime {
	const { known = true, off = false, paused, authed = true, inCatalog = true, hidden = false, plan = [] } = facts;
	const available = [make("beta", "model")];
	return {
		getAvailableSnapshot: () => available,
		isModelDeprecated: () => false,
		getProvider: (provider: string) => (provider !== "alpha" || known ? { id: provider } : undefined),
		isProviderDisabled: (provider: string) => provider === "alpha" && off,
		getPlanDisabledReason: (provider: string) => (provider === "alpha" ? paused : undefined),
		hasConfiguredAuth: (provider: string) => provider !== "alpha" || authed,
		getModel: (provider: string, id: string) => (provider !== "alpha" || inCatalog ? make(provider, id) : undefined),
		isModelHidden: (model: { provider: string }) => model.provider === "alpha" && hidden,
		getProviderBilling: (provider: string) => (plan.includes(provider) ? "plan" : "metered"),
		allowsUnattendedUse: () => true,
	} as unknown as Runtime;
}

const start = (modelRuntime: Runtime) =>
	findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: "alpha",
		defaultModelId: "model",
		modelRuntime,
	});

describe("startup notice for a saved default that was not used", () => {
	it.each([
		[{ known: false }, "provider not configured"],
		[{ off: true, authed: false, inCatalog: false }, "provider off"],
		[{ paused: "the vendor paused plan routing", authed: false }, "provider paused (the vendor paused plan routing)"],
		[{ authed: false, inCatalog: false }, "no credentials"],
		[{ inCatalog: false }, "model not in the catalog"],
		[{ hidden: true }, "model hidden"],
	] as const)("names the first failed check: %j → %s", async (facts, reason) => {
		const result = await start(runtimeWith(facts));
		expect(result.model?.provider).toBe("beta");
		expect(result.fallbackMessage).toMatch(
			new RegExp(`^Saved default alpha/model not used: ${reason.replace(/[()]/g, "\\$&")}\\. Using beta/model`),
		);
	});

	it("names the replacement's billing when the saved provider has no credentials", async () => {
		expect((await start(runtimeWith({ authed: false }))).fallbackMessage).toBe(
			"Saved default alpha/model not used: no credentials. Using beta/model (billed per token).",
		);
		expect((await start(runtimeWith({ authed: false, plan: ["beta"] }))).fallbackMessage).toBe(
			"Saved default alpha/model not used: no credentials. Using beta/model (billed by plan).",
		);
	});

	it("names the billing only when it differs from the saved provider's", async () => {
		expect((await start(runtimeWith({ off: true }))).fallbackMessage).toBe(
			"Saved default alpha/model not used: provider off. Using beta/model.",
		);
		expect((await start(runtimeWith({ off: true, plan: ["alpha"] }))).fallbackMessage).toBe(
			"Saved default alpha/model not used: provider off. Using beta/model (billed per token).",
		);
	});

	it("says nothing when the saved default is used or none is saved", async () => {
		const runtime = runtimeWith();
		const used = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "beta",
			defaultModelId: "model",
			modelRuntime: runtime,
		});
		expect(used.fallbackMessage).toBeUndefined();
		const none = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		expect(none.fallbackMessage).toBeUndefined();
	});

	it("keeps the reason without a replacement when no model is available", async () => {
		const empty = { ...runtimeWith({ authed: false }), getAvailableSnapshot: () => [] } as unknown as Runtime;
		const result = await start(empty);
		expect(result.model).toBeUndefined();
		expect(result.fallbackMessage).toBe("Saved default alpha/model not used: no credentials.");
	});
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixtureProvider(id: string): Provider<"openai-completions"> {
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async () => ({ type: "api_key", key: "fixture" }),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async () => ({ auth: { apiKey: "fixture" }, source: "stored" }),
			},
		},
		getModels: () => [make(id, "model")],
		stream: () => {
			throw new Error("No inference expected");
		},
		streamSimple: () => {
			throw new Error("No inference expected");
		},
	};
}

/** A new session whose saved default is `alpha/model`; only the providers in `stored` have credentials. */
async function newSession(stored: readonly string[]) {
	const root = mkdtempSync(join(tmpdir(), "octocode-saved-default-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(Object.fromEntries(stored.map((id) => [id, { type: "api_key", key: id }]))),
		modelsPath: null,
		allowModelNetwork: false,
	});
	cleanups.push(() => runtime.dispose());
	for (const id of ["alpha", "beta"]) runtime.registerNativeProvider(fixtureProvider(id));
	await runtime.refresh({ allowNetwork: false, providers: ["alpha", "beta"] });
	await runtime.getAvailable();
	const created = await createSessionFromServices({
		services: {
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "alpha", defaultModel: "model" }),
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		},
		sessionManager: SessionManager.inMemory(root),
		noTools: "all",
	});
	cleanups.push(() => created.session.dispose());
	return created;
}

describe("a new session with a saved default on a provider without credentials", () => {
	it("warns with the default, the reason, the replacement and its billing", async () => {
		const { session, modelFallbackMessage } = await newSession(["beta"]);
		expect(session.model?.provider).toBe("beta");
		expect(modelFallbackMessage).toBe(
			"Saved default alpha/model not used: no credentials. Using beta/model (billed per token).",
		);
	});

	it("keeps the no-provider guidance when nothing is connected", async () => {
		const { modelFallbackMessage } = await newSession([]);
		expect(modelFallbackMessage).toBe(
			`Saved default alpha/model not used: no credentials. ${formatNoModelsAvailableMessage()}`,
		);
	});

	it("has no warning when the saved default is used", async () => {
		const { session, modelFallbackMessage } = await newSession(["alpha", "beta"]);
		expect(session.model?.provider).toBe("alpha");
		expect(modelFallbackMessage).toBeUndefined();
	});
});
