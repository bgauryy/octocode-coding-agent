import type { ProviderPlan } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
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

const oauth = (access: string) => ({
	type: "oauth" as const,
	access,
	refresh: `${access}-refresh`,
	expires: Date.now() + 60 * 60_000,
});

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});

function register(runtime: ModelRuntime, id: string, baseUrls: readonly string[]): void {
	runtime.registerProvider(id, {
		baseUrl: baseUrls[0],
		apiKey: "test-key",
		api: "openai-completions",
		models: baseUrls.map((baseUrl, index) => ({ ...model(`${id}-${index}`), baseUrl })),
	});
}

describe("provider kind", () => {
	it("names a plan that runs through the vendor's CLI first, even when it bills by plan", async () => {
		const runtime = await runtimeWith({ "opencode-go": { type: "api_key", key: "go-key" } });
		const plan = runtime.getProviderPlan("opencode-go")!;
		vi.spyOn(runtime, "getProviderPlan").mockReturnValue({ ...plan, transport: "cli" } satisfies ProviderPlan);
		expect(runtime.getProviderKind("opencode-go")).toBe("CLI");
		// The credential kind reads the same facts: the plan still bills by subscription.
		expect(await runtime.getCredentialKind("opencode-go")).toBe("subscription");
	});

	it("names subscription sign-ins and plan keys subscription", async () => {
		const runtime = await runtimeWith({
			openai: oauth("openai-access"),
			"opencode-go": { type: "api_key", key: "go-key" },
		});
		expect(runtime.getProviderKind("openai")).toBe("subscription");
		expect(runtime.getProviderKind("opencode-go")).toBe("subscription");
	});

	it("names an OAuth login that is not a plan account", async () => {
		const runtime = await runtimeWith({ openrouter: oauth("openrouter-access") });
		expect(runtime.isUsingOAuth("openrouter")).toBe(true);
		expect(runtime.getProviderKind("openrouter")).toBe("account");
		expect(await runtime.getCredentialKind("openrouter")).toBe("account");
	});

	it("names a provider whose every model is on this machine local", async () => {
		const runtime = await runtimeWith({});
		register(runtime, "ollama", ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1"]);
		register(runtime, "ipv6-server", ["http://[::1]:8080/v1"]);
		register(runtime, "mixed", ["http://localhost:11434/v1", "https://api.example.test/v1"]);
		expect(runtime.getProviderKind("ollama")).toBe("local");
		expect(runtime.getProviderKind("ipv6-server")).toBe("local");
		expect(runtime.getProviderKind("mixed")).toBe("API key");
		expect(await runtime.getCredentialKind("ollama")).toBe("key");
	});

	it("names metered keys and unconfigured providers API key", async () => {
		const runtime = await runtimeWith({
			anthropic: { type: "api_key", key: "sk-ant-api03-test" },
			openrouter: { type: "api_key", key: "sk-or-test" },
		});
		expect(runtime.getProviderKind("anthropic")).toBe("API key");
		expect(runtime.getProviderKind("openrouter")).toBe("API key");
		expect(runtime.getProviderKind("google")).toBe("API key");
		expect(runtime.getProviderKind("no-such-provider")).toBe("API key");
	});
});
