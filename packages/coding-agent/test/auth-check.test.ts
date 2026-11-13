import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { FileModelsStore } from "../src/core/models-store.ts";

const tempDir = join(tmpdir(), `octocode-test-auth-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openai/gpt-5.5"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai", "--model", "gpt-5.5"]), runtime),
		).resolves.toMatchObject({ status: "ready", provider: "openai" });
	});

	test("reads credentials without refreshing OAuth when requested", async () => {
		const apiCredentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } });
		const apiRuntime = await createRuntime(apiCredentials);
		await expect(getProviderCredential("openai", apiRuntime, apiCredentials, { refresh: false })).resolves.toBe(
			"test-key",
		);

		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const oauthRuntime = await createRuntime(credentials);
		const oauth = oauthRuntime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(oauth.refresh);
		oauth.refresh = refresh;

		await expect(getProviderCredential("openai-codex", oauthRuntime, credentials, { refresh: false })).resolves.toBe(
			"old-token",
		);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("refreshes OAuth by default", async () => {
		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const runtime = await createRuntime(credentials);
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		oauth.refresh = refresh;

		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai-codex"]), runtime, { refresh: true }),
		).resolves.toMatchObject({
			status: "ready",
		});
		expect(refresh).toHaveBeenCalledOnce();
	});

	test("reports an unknown provider as not ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(checkProviderAuth(parseArgs(["--provider", "not-installed"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("cancels an auth check even when the provider check never settles", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());
		const apiKey = runtime.getProvider("openai")?.auth.apiKey;
		if (!apiKey) throw new Error("OpenAI API-key provider is not registered");
		const originalCheck = apiKey.check;
		const started = Promise.withResolvers<void>();
		apiKey.check = () => {
			started.resolve();
			return new Promise(() => {});
		};
		try {
			const controller = new AbortController();
			const checking = checkProviderAuth(parseArgs(["--provider", "openai"]), runtime, {
				refresh: true,
				signal: controller.signal,
			});
			await started.promise;
			controller.abort();
			await expect(checking).resolves.toEqual({ status: "invalid", provider: "openai", reason: "invalid_state" });
		} finally {
			apiKey.check = originalCheck;
			runtime.dispose();
		}
	});

	test("does not treat an unresolved stored environment reference as configured", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "$MISSING_AUTH_CHECK_KEY" } }), "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
	});

	test("reports malformed auth state as invalid", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "{invalid-json", "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "invalid",
			provider: "openai",
			reason: "invalid_state",
		});
	});

	test("does not create an auth file or its parent directory", async () => {
		const authPath = join(tempDir, "agent", "auth.json");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toMatchObject({
			status: "not_ready",
			reason: "credentials_not_configured",
		});
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	test("accepts optional JSON output, credential output, and --no-refresh", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(
			parseAuthCommand(["auth", "check", "--json", "--credentials", "--no-refresh", "--provider", "openai"]),
		).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: true,
			credentials: true,
			noRefresh: true,
		});
	});

	test("creates an auth-check runtime without catalog storage", async () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tempDir);
		const storePath = join(tempDir, "models-store.json");
		await new FileModelsStore(storePath).write("openai", {
			models: [
				{
					id: "stored-only",
					name: "stored-only",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.test/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			checkedAt: Date.now(),
			// Newer than the bundled catalog, so a runtime that reads the store overlays it.
			lastModified: Date.now() + 365 * 24 * 3_600_000,
		});
		const stored = readFileSync(storePath, "utf8");
		// Control: a default runtime reads the agent directory's catalog store.
		const defaults = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		await defaults.refresh({ allowNetwork: false });
		expect(defaults.getModel("openai", "stored-only")?.id).toBe("stored-only");

		const runtime = await createAuthCheckModelRuntime(AuthStorage.inMemory());
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProvider("openai")?.id).toBe("openai");
		expect(runtime.getModel("openai", "stored-only")).toBeUndefined();
		expect(readFileSync(storePath, "utf8")).toBe(stored);
	});
});
