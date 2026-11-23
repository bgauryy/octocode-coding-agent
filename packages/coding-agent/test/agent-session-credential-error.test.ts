import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	CLI_LOGIN,
	type CredentialFixRuntime,
	explainCredentialError,
} from "../src/core/agent-session/credential-error-context.ts";
import { setAuthGuidanceSurface } from "../src/core/auth-guidance.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RUNNERS } from "../src/octocode/external/runners.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const MODEL = "claude-sonnet-4-5";

function failed(errorMessage: string, provider = "anthropic", model = MODEL): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("credential errors in a session", () => {
	let session: AgentSession | undefined;
	const tempDir = join(tmpdir(), `octocode-credential-error-${process.pid}-${Date.now()}`);
	afterEach(() => {
		session?.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function run(errorMessage: string): Promise<string | undefined> {
		mkdirSync(tempDir, { recursive: true });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", MODEL), systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const msg = failed(errorMessage);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: false } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		let shown: string | undefined;
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") shown = event.message.errorMessage;
		});
		await session.prompt("Test");
		return shown;
	}

	it("names the provider and model on a credential error, and ends with the fix", async () => {
		const shown = await run("Your session has expired. Please reauthenticate.");
		expect(shown).toContain(`anthropic/${MODEL}`);
		expect(shown).toContain("Your session has expired");
		expect(shown).toMatch(/\nFix: \/providers → Anthropic$/);
	});

	it("does not repeat a provider the message already names", async () => {
		const shown = await run("anthropic: 401 invalid api key");
		expect(shown?.match(/anthropic/g)).toHaveLength(1);
	});

	it("leaves non-credential errors alone", async () => {
		expect(await run("500 internal server error")).toBe("500 internal server error");
	});
});

/** A runtime that answers how a provider signs in, and records whether the Bedrock lookup ran. */
function runtime(options: { kind?: string; auth?: Awaited<ReturnType<CredentialFixRuntime["getAuth"]>> } = {}) {
	const names: Record<string, string> = { "amazon-bedrock": "Amazon Bedrock", "claude-code": "Claude Code" };
	return {
		getProvider: (id: string) => (names[id] ? { name: names[id] } : undefined),
		getProviderKind: () => options.kind ?? "API key",
		getAuth: vi.fn(async () => options.auth),
	} as unknown as CredentialFixRuntime & { getAuth: ReturnType<typeof vi.fn> };
}

async function explain(text: string, provider: string, fixRuntime: CredentialFixRuntime, env: NodeJS.ProcessEnv = {}) {
	const message = failed(text, provider, "model-x");
	await explainCredentialError(message, fixRuntime, env);
	return message.errorMessage;
}

describe("the fix a credential failure ends with", () => {
	it.each([
		"Your session has expired. Please reauthenticate.",
		"Token is expired",
		"Could not load credentials from any providers",
		"ExpiredTokenException: The security token included in the request is expired",
		"UnrecognizedClientException: The security token included in the request is invalid.",
		// The AWS SDK's own SSO wording, without a status or a "token is ..." phrase.
		"The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
		"The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
		"Unable to locate credentials",
	])("points Bedrock signed in through AWS_PROFILE at aws sso login for %j", async (text) => {
		const shown = await explain(text, "amazon-bedrock", runtime({ auth: { auth: {}, source: "AWS_PROFILE" } }), {
			AWS_PROFILE: "dev",
		});
		expect(shown).toMatch(
			/\nFix: run `aws sso login --profile dev`, switch model with \/model, or \/providers → Amazon Bedrock$/,
		);
	});

	it("names the profile a stored Bedrock sign-in uses, and none for the shared configuration", async () => {
		const stored = runtime({ auth: { auth: {}, env: { AWS_PROFILE: "work" }, source: "stored credential" } });
		expect(await explain("Token is expired", "amazon-bedrock", stored)).toContain("`aws sso login --profile work`");
		const shared = runtime({ auth: { auth: {}, source: "AWS shared configuration" } });
		expect(await explain("Token is expired", "amazon-bedrock", shared)).toContain("`aws sso login`,");
	});

	it.each([
		["a bearer token", { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" }],
		["static keys", { auth: {}, source: "AWS access keys" }],
		["a stored bearer key", { auth: { apiKey: "key" }, source: "stored credential" }],
		["a role", { auth: {}, source: "ECS task role" }],
	] as const)("sends Bedrock signed in with %s to /providers, never to aws sso login", async (_name, auth) => {
		const shown = await explain("Token is expired", "amazon-bedrock", runtime({ auth }), { AWS_PROFILE: "dev" });
		expect(shown).not.toContain("sso");
		expect(shown).toMatch(/\nFix: \/providers → Amazon Bedrock$/);
	});

	it("on the command line says where /providers and another model are found", async () => {
		setAuthGuidanceSurface("cli");
		try {
			const sso = runtime({ auth: { auth: {}, source: "AWS_PROFILE" } });
			expect(await explain("Token is expired", "amazon-bedrock", sso, { AWS_PROFILE: "dev" })).toMatch(
				new RegExp(
					`\\nFix: run \`aws sso login --profile dev\`, pick another model with --model, or run \`${APP_NAME}\` and open /providers → Amazon Bedrock$`,
				),
			);
			expect(await explain("401 invalid api key", "amazon-bedrock", runtime())).toMatch(
				new RegExp(`\\nFix: run \`${APP_NAME}\` and open /providers → Amazon Bedrock$`),
			);
		} finally {
			setAuthGuidanceSurface("session");
		}
	});

	it("names an external agent's own login command", async () => {
		const shown = await explain("401 invalid api key", "claude-code", runtime({ kind: "CLI" }));
		expect(shown).toMatch(/\nFix: run `claude auth login`$/);
	});

	it("keeps each CLI provider's login equal to its runner's", () => {
		for (const [provider, login] of Object.entries(CLI_LOGIN)) {
			const runner = RUNNERS.find((entry) => entry.id === provider);
			expect(runner, provider).toBeDefined();
			expect(login).toBe([runner?.cli, ...(runner?.login ?? [])].join(" "));
		}
	});

	it("looks nothing up for other failures, and adds no second fix", async () => {
		const fixRuntime = runtime({ auth: { auth: {}, source: "AWS_PROFILE" } });
		expect(await explain("The provided model identifier is invalid.", "amazon-bedrock", fixRuntime)).toBe(
			"The provided model identifier is invalid.",
		);
		expect(fixRuntime.getAuth).not.toHaveBeenCalled();
		const once = await explain("Token is expired", "anthropic", runtime());
		const message = failed(once ?? "", "anthropic", "model-x");
		await explainCredentialError(message, runtime(), {});
		expect(message.errorMessage).toBe(once);
	});
});
