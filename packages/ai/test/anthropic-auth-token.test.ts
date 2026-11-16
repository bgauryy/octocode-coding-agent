import { arch, platform, release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL } from "../src/api/anthropic-messages/token.ts";
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = { headers: undefined as Headers | undefined, body: undefined as Record<string, unknown> | undefined };

beforeEach(() => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		mockState.headers = new Headers(init?.headers);
		mockState.body = JSON.parse(init?.body as string);
		return createSseResponse();
	});
});

const OCTOCODE_USER_AGENT = `octocode (${platform()} ${release()}; ${arch()})`;
const neverAbortedSignal = new AbortController().signal;

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

const kimiCodingModel: Model<"anthropic-messages"> = {
	...anthropicModel,
	id: "kimi-for-coding",
	name: "Kimi For Coding",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};

afterEach(() => {
	mockState.headers = undefined;
	mockState.body = undefined;
});

describe("Anthropic auth token env", () => {
	it("resolves ANTHROPIC_AUTH_TOKEN as a bearer Authorization header", async () => {
		const provider = anthropicProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) =>
					({
						ANTHROPIC_AUTH_TOKEN: "auth-token",
						ANTHROPIC_OAUTH_TOKEN: "oauth-token",
						ANTHROPIC_API_KEY: "api-key",
					})[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: ANTHROPIC_AUTH_TOKEN_ENV,
		});
	});

	it("prefers ANTHROPIC_API_KEY over a subscription token in ANTHROPIC_OAUTH_TOKEN", async () => {
		const provider = anthropicProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) =>
					({
						ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-token",
						ANTHROPIC_API_KEY: "api-key",
					})[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({ auth: { apiKey: "api-key" }, source: ANTHROPIC_API_KEY_ENV });
	});

	it("still resolves ANTHROPIC_OAUTH_TOKEN alone, so a request can say why it is refused", async () => {
		const auth = await anthropicProvider().auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? "sk-ant-oat01-token" : undefined),
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({ auth: { apiKey: "sk-ant-oat01-token" }, source: ANTHROPIC_OAUTH_TOKEN_ENV });
	});

	it("uses Authorization headers without OAuth-mode request shaping", async () => {
		const stream = streamAnthropic(anthropicModel, context, {
			headers: { Authorization: "Bearer gateway-token" },
		});
		await stream.result();

		expect(mockState.headers?.has("x-api-key")).toBe(false);
		const headers = mockState.headers!;
		expect(headers.get("authorization")).toBe("Bearer gateway-token");
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("oauth-2025-04-20");
		expect(mockState.body?.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it("threads authContext ANTHROPIC_AUTH_TOKEN through request headers", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, context).result();

		expect(mockState.headers?.has("x-api-key")).toBe(false);
		const headers = mockState.headers!;
		expect(headers.get("authorization")).toBe("Bearer ctx-token");
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("oauth-2025-04-20");
		expect(mockState.body?.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it("refuses a subscription token from ANTHROPIC_OAUTH_TOKEN before any request is built", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? "sk-ant-oat01-test" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		const result = await models.streamSimple(anthropicModel, context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
		expect(mockState.headers).toBeUndefined();
		expect(mockState.body).toBeUndefined();
	});

	it("lets explicit request headers override ANTHROPIC_AUTH_TOKEN", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models
			.streamSimple(anthropicModel, context, { headers: { Authorization: "Bearer explicit-token" } })
			.result();

		const headers = mockState.headers!;
		expect(headers.get("authorization")).toBe("Bearer explicit-token");
	});
});

describe("Anthropic-compatible user agents", () => {
	it("uses the default User-Agent for Anthropic Messages requests", async () => {
		await streamAnthropic(anthropicModel, context, { apiKey: "anthropic-key" }).result();

		const headers = mockState.headers!;
		expect(headers.get("user-agent")).toBe(OCTOCODE_USER_AGENT);
	});

	it("lets explicit headers override the default Anthropic Messages User-Agent", async () => {
		await streamAnthropic(kimiCodingModel, context, {
			apiKey: "kimi-key",
			headers: { "User-Agent": "custom-client" },
		}).result();

		const headers = mockState.headers!;
		expect(headers.get("user-agent")).toBe("custom-client");
	});

	it("sends a configured beta header when Octocode needs no betas of its own", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "anthropic-key",
			headers: { "anthropic-beta": "custom-beta" },
		}).result();

		expect(mockState.headers?.get("anthropic-beta")?.split(",")).toEqual(["custom-beta"]);
	});

	it("preserves explicit Anthropic beta header suppression", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "anthropic-key",
			headers: { "anthropic-beta": null },
		}).result();

		expect(mockState.headers?.get("anthropic-beta")?.split(",")).toBeUndefined();
	});
});

describe("no Claude Code identity on any Anthropic path", () => {
	const copilotModel: Model<"anthropic-messages"> = {
		...anthropicModel,
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
	};
	const paths: Array<[string, Model<"anthropic-messages">, { apiKey?: string; headers?: Record<string, string> }]> = [
		["an API key", anthropicModel, { apiKey: "sk-ant-api03-test" }],
		["an Authorization header", anthropicModel, { headers: { Authorization: "Bearer gateway-token" } }],
		["a bearer-auth provider", copilotModel, { apiKey: "copilot-token" }],
		["an Anthropic-compatible host", kimiCodingModel, { apiKey: "kimi-key" }],
	];

	it.each(paths)("sends no claude-cli User-Agent, x-app or identity block with %s", async (_label, model, options) => {
		await streamAnthropic(model, context, options).result();

		const headers = Object.fromEntries(
			[...(mockState.headers?.entries() ?? [])].map(([name, value]) => [name.toLowerCase(), value]),
		);
		expect(headers["user-agent"]).not.toMatch(/claude-cli/);
		expect(headers["x-app"]).toBeUndefined();
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("claude-code-20250219");
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("oauth-2025-04-20");
		expect(JSON.stringify(mockState.body?.system)).not.toContain("You are Claude Code");
		expect(mockState.body?.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it.each([
		["an API key", { apiKey: "sk-ant-oat01-test" }],
		["an Authorization header", { headers: { Authorization: "Bearer sk-ant-oat01-test" } }],
		["an x-api-key header", { headers: { "x-api-key": "sk-ant-oat01-test" } }],
	])("refuses a subscription token passed as %s and sends nothing", async (_label, options) => {
		const result = await streamAnthropic(anthropicModel, context, options).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
		expect(result.errorMessage).toContain("external agent");
		expect(mockState.headers).toBeUndefined();
		expect(mockState.body).toBeUndefined();
	});
});
