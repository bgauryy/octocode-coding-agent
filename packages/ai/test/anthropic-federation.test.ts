import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = {
	exchange: undefined as Record<string, unknown> | undefined,
	headers: undefined as Headers | undefined,
};
vi.mock("node:fs/promises", async (original) => ({
	...(await original<object>()),
	open: vi.fn(async () => ({
		read: async (buffer: Buffer) => ({ bytesRead: buffer.write("test.identity.token") }),
		close: async () => undefined,
	})),
}));

beforeEach(() => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		if (new URL(input).pathname === "/v1/oauth/token") {
			mockState.exchange = JSON.parse(init?.body as string);
			return Response.json({ access_token: "exchanged-token", expires_in: 3600, token_type: "Bearer" });
		}
		mockState.headers = new Headers(init?.headers);
		return createSseResponse();
	});
});

const neverAbortedSignal = new AbortController().signal;

const federationEnv = {
	ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
	ANTHROPIC_ORGANIZATION_ID: "org-test",
	ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
	ANTHROPIC_IDENTITY_TOKEN_FILE: "/tmp/identity.jwt",
};

const expectedExchange = {
	grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
	assertion: "test.identity.token",
	organization_id: "org-test",
	federation_rule_id: "fdrl_test",
	service_account_id: "svac_test",
};

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

function resolveWithEnv(env: Record<string, string>) {
	return anthropicProvider().auth.apiKey?.resolve({
		ctx: { env: async (name) => env[name], fileExists: async () => false },
		signal: neverAbortedSignal,
	});
}

afterEach(() => {
	mockState.exchange = undefined;
	mockState.headers = undefined;
});

describe("Anthropic workload identity federation", () => {
	it("resolves the federation variables as provider env with no request auth", async () => {
		expect(await resolveWithEnv(federationEnv)).toEqual({
			auth: {},
			env: federationEnv,
			source: "workload identity federation",
		});
	});

	it("passes ANTHROPIC_WORKSPACE_ID through when set", async () => {
		const result = await resolveWithEnv({ ...federationEnv, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" });
		expect(result?.env?.ANTHROPIC_WORKSPACE_ID).toBe("wrkspc_test");
	});

	it("is not configured when a federation variable is missing", async () => {
		const { ANTHROPIC_IDENTITY_TOKEN_FILE: _omitted, ...partial } = federationEnv;
		expect(await resolveWithEnv(partial)).toBeUndefined();
	});

	it("treats ANTHROPIC_SERVICE_ACCOUNT_ID as optional, like the SDK", async () => {
		const { ANTHROPIC_SERVICE_ACCOUNT_ID: _omitted, ...partial } = federationEnv;
		expect(await resolveWithEnv(partial)).toEqual({
			auth: {},
			env: partial,
			source: "workload identity federation",
		});

		await streamAnthropic(anthropicModel, context, { env: partial }).result();
		const { service_account_id: _service, ...optionalExchange } = expectedExchange;
		expect(mockState.exchange).toEqual(optionalExchange);
	});

	it("keeps API key and auth token precedence over federation", async () => {
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_API_KEY: "api-key" })).toEqual({
			auth: { apiKey: "api-key" },
			source: "ANTHROPIC_API_KEY",
		});
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_AUTH_TOKEN: "auth-token" })).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: "ANTHROPIC_AUTH_TOKEN",
		});
	});

	it("hands the SDK a federation config instead of a key", async () => {
		await streamAnthropic(anthropicModel, context, { env: federationEnv }).result();

		expect(mockState.headers?.has("x-api-key")).toBe(false);
		expect(mockState.headers?.get("authorization")).toBe("Bearer exchanged-token");
		expect(mockState.exchange).toEqual(expectedExchange);
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("oauth-2025-04-20");
	});

	it("threads authContext federation variables through Models", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => federationEnv[name as keyof typeof federationEnv],
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, context).result();

		expect(mockState.headers?.has("x-api-key")).toBe(false);
		expect(mockState.headers?.get("authorization")).toBe("Bearer exchanged-token");
		expect(mockState.exchange).toEqual(expectedExchange);
	});

	it("lets an explicit API key win over federation env", async () => {
		await streamAnthropic(anthropicModel, context, { apiKey: "explicit-key", env: federationEnv }).result();

		expect(mockState.headers?.get("x-api-key")).toBe("explicit-key");
		expect(mockState.exchange).toBeUndefined();
	});

	it("does not federate other anthropic-messages providers", async () => {
		const kimi: Model<"anthropic-messages"> = {
			...anthropicModel,
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
		};
		const message = await streamAnthropic(kimi, context, { env: federationEnv }).result();

		expect(message.stopReason).toBe("error");
		expect(mockState.headers).toBeUndefined();
		expect(mockState.exchange).toBeUndefined();
	});
});
