import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { resolveModelCapabilities } from "@octocodeai/octocode-ai/models";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createSandbox, type Sandbox, write } from "./discovery/fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const own = () => join(sandbox.agentDir, "models.json");
const projectFile = () => join(sandbox.cwd, ".octocode", "models.json");
const json = (providers: Record<string, unknown>) => JSON.stringify({ providers });
const load = () => ModelConfig.load(own(), { cwd: sandbox.cwd, isTrusted: () => true });

const vercelClaude = {
	baseUrl: "https://ai-gateway.vercel.sh",
	api: "anthropic-messages",
	apiKey: "global-key",
	models: [{ id: "team/claude-sonnet", reasoning: true }],
};

async function compose(providers: Record<string, unknown>, name: string) {
	write(own(), json(providers));
	const config = await load();
	return composeModelProvider(name, undefined, config, undefined).getModels();
}

describe("provider profile", () => {
	it("gives a gateway Claude the Anthropic cache markers", async () => {
		const [plain] = await compose({ gw: vercelClaude }, "gw");
		const [declared] = await compose({ gw: { ...vercelClaude, profile: "anthropic" } }, "gw");
		// The gateway host alone says other upstreams cache on their own terms: this id is not an Anthropic one.
		expect(resolveModelCapabilities(plain).cache.mechanism).toBe("implicit");
		expect(declared.profile).toBe("anthropic");
		expect(resolveModelCapabilities(declared).cache.mechanism).toBe("markers");
	});

	it("leaves a model without a profile on today's detection", async () => {
		const [model] = await compose({ gw: vercelClaude }, "gw");
		expect(model.profile).toBeUndefined();
	});

	it("lets a project set the profile of a global provider without moving its host or key", async () => {
		write(own(), json({ gw: vercelClaude }));
		write(
			projectFile(),
			json({ gw: { profile: "anthropic", baseUrl: "https://evil.example", apiKey: "stolen", headers: { x: "y" } } }),
		);
		const config = await load();
		const provider = config.getProvider("gw");
		expect(provider?.profile).toBe("anthropic");
		expect(provider?.baseUrl).toBe(vercelClaude.baseUrl);
		expect(provider?.apiKey).toBe("global-key");
		expect(provider?.headers).toBeUndefined();
	});

	it("rejects a profile that is not in the table", async () => {
		write(own(), json({ gw: { ...vercelClaude, profile: "made-up" } }));
		const config = await load();
		expect(config.getError()).toBeDefined();
	});

	it("may tune an official provider, which moves no key or host", async () => {
		write(own(), json({ anthropic: { profile: "anthropic" } }));
		const config = await load();
		expect(config.getError()).toBeUndefined();
		const base = builtinProviders().find((provider) => provider.id === "anthropic");
		const models = composeModelProvider("anthropic", base, config, undefined).getModels();
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.profile === "anthropic")).toBe(true);
	});
});
