import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const providerModel: Model<"openai-completions"> = {
	id: "dynamic",
	name: "Dynamic",
	api: "openai-completions",
	provider: "shared",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const provider: Provider<"openai-completions"> = {
	id: "shared",
	name: "shared",
	auth: {
		apiKey: {
			name: "API key",
			login: async () => ({ type: "api_key", key: "unused" }),
			check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
			resolve: async ({ credential }) =>
				credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
		},
	},
	getModels: () => [providerModel],
	stream: () => {
		throw new Error("unused");
	},
	streamSimple: () => {
		throw new Error("unused");
	},
};

describe("credentials saved by another process", () => {
	it("a running runtime sees a credential another store adds, then removes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-auth-watch-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		const running = await ModelRuntime.create({
			credentials: AuthStorage.create(authPath),
			modelsPath: null,
			allowModelNetwork: false,
		});
		running.registerNativeProvider(provider);
		await running.refresh({ allowNetwork: false, providers: ["shared"] });
		expect(running.getAvailableSnapshot().map((entry) => entry.provider)).not.toContain("shared");

		const other = AuthStorage.create(authPath);
		await other.modify("shared", async () => ({ type: "api_key", key: "!keychain-reference" }));
		await expect
			.poll(() => running.getAvailableSnapshot().map((entry) => entry.provider), { timeout: 5000 })
			.toContain("shared");

		await other.delete("shared");
		await expect
			.poll(() => running.getAvailableSnapshot().map((entry) => entry.provider), { timeout: 5000 })
			.not.toContain("shared");
	});
});
