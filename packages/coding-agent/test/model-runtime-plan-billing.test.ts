import { kimiCodingProvider } from "@octocodeai/octocode-ai/providers/kimi-coding";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function runtimeWith(credentials: Parameters<typeof AuthStorage.inMemory>[0]): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(credentials),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.refresh({ allowNetwork: false });
	await runtime.getAvailable();
	return runtime;
}

const PLAN_PROVIDERS = [
	"kimi-coding",
	"opencode-go",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"xiaomi-token-plan-sgp",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"zai",
	"zai-coding-cn",
] as const;

const oauth = (access: string) => ({
	type: "oauth" as const,
	access,
	refresh: `${access}-refresh`,
	expires: Date.now() + 60 * 60_000,
});

describe("plan billing", () => {
	it("reports every declared plan provider signed in with a key as plan-billed, in every view", async () => {
		const runtime = await runtimeWith(
			Object.fromEntries(PLAN_PROVIDERS.map((id) => [id, { type: "api_key", key: `${id}-key` }])),
		);
		for (const id of PLAN_PROVIDERS) {
			expect(runtime.getProviderPlan(id)?.billing, id).toBe("plan");
			expect(runtime.isUsingSubscription(id), id).toBe(true);
			expect(runtime.getProviderBilling(id), id).toBe("plan");
			expect(await runtime.getCredentialKind(id), id).toBe("subscription");
		}
	});

	it("counts subscription sign-ins (ChatGPT, Copilot) as plan and metered keys as metered", async () => {
		const runtime = await runtimeWith({
			openai: oauth("openai-access"),
			"github-copilot": oauth("tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;"),
			openrouter: { type: "api_key", key: "sk-or-test" },
		});
		expect(runtime.getProviderBilling("openai")).toBe("plan");
		expect(await runtime.getCredentialKind("openai")).toBe("subscription");
		expect(runtime.getProviderBilling("github-copilot")).toBe("plan");
		expect(await runtime.getCredentialKind("github-copilot")).toBe("subscription");
		expect(runtime.getProviderBilling("openrouter")).toBe("metered");
		expect(await runtime.getCredentialKind("openrouter")).toBe("key");
	});

	it("exposes which plans forbid unattended use", async () => {
		const runtime = await runtimeWith({});
		for (const id of ["qwen-token-plan", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn"]) {
			expect(runtime.allowsUnattendedUse(id), id).toBe(false);
		}
		for (const id of ["kimi-coding", "opencode-go", "openai", "anthropic"]) {
			expect(runtime.allowsUnattendedUse(id), id).toBe(true);
		}
	});

	it("marks the legacy Codex route deprecated without pausing it", async () => {
		const runtime = await runtimeWith({});
		expect(runtime.getProviderPlan("openai-codex")?.deprecated).toContain("/providers openai");
		expect(runtime.getPlanDisabledReason("openai-codex")).toBeUndefined();
	});

	it("takes a paused plan's models out of availability and keeps its stored login", async () => {
		const runtime = await runtimeWith({ "kimi-coding": { type: "api_key", key: "kimi-key" } });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "kimi-coding")).toBe(true);

		const base = kimiCodingProvider();
		runtime.registerNativeProvider({
			...base,
			auth: { ...base.auth, plan: { ...base.auth.plan!, disabled: "Paused after a vendor objection." } },
		});
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getPlanDisabledReason("kimi-coding")).toBe("Paused after a vendor objection.");
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "kimi-coding")).toBe(false);
		expect((await runtime.getAvailable()).some((model) => model.provider === "kimi-coding")).toBe(false);
		expect(runtime.hasConfiguredAuth("kimi-coding")).toBe(true);
	});
});
