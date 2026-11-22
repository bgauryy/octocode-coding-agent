import { describe, expect, test } from "vitest";
import { normalizeEndpointHost } from "../src/auth/endpoint.ts";
import {
	bedrockEndpoint,
	bedrockHostFamily,
	bedrockRoute,
	mantleRoute,
} from "../src/providers/amazon-bedrock-endpoint.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { AuthContext } from "../src/auth/types.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";

const mantle = "https://bedrock-mantle.eu-central-1.api.aws/v1";
const model = (id: string, baseUrl: string) => ({ id, baseUrl, api: "bedrock-converse-stream" }) as never;

describe("custom Amazon Bedrock host", () => {
	test("the host name tells the request API", () => {
		expect(bedrockHostFamily("https://bedrock-runtime.eu-central-1.amazonaws.com")).toBe("runtime");
		expect(bedrockHostFamily(mantle)).toBe("mantle");
		expect(bedrockHostFamily("https://llm.corp.example/v1")).toBe("unknown");
		expect(bedrockHostFamily("https://bedrock-runtime.us-east-1.amazonaws.com.example.org/v1")).toBe("unknown");
		expect(bedrockHostFamily("not a url")).toBe("unknown");
	});

	test("bedrock-runtime keeps the Converse stream and the model's own host", () => {
		const url = "https://bedrock-runtime.eu-central-1.amazonaws.com";
		expect(bedrockRoute(model("anthropic.claude-fable-5", url), undefined)).toEqual({
			api: "bedrock-converse-stream",
			baseUrl: url,
		});
	});

	test("keeps the AWS OpenAI-compatible runtime base URL on bearer login", () => {
		const baseUrl = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
		expect(bedrockEndpoint({ host: baseUrl }, "bearer-token")?.baseUrl).toBe(baseUrl);
		expect(bedrockRoute(model("global.moonshotai.kimi-k3.1", baseUrl), undefined)).toEqual({
			api: "openai-completions",
			baseUrl,
		});
		expect(() => bedrockEndpoint({ host: baseUrl }, "aws-profile")).toThrow(/bearer token/);
	});

	test("bedrock-mantle picks the base path and API per model family", () => {
		expect(mantleRoute("moonshotai.kimi-k3.1", mantle)).toEqual({
			api: "openai-completions",
			baseUrl: "https://bedrock-mantle.eu-central-1.api.aws/v1",
		});
		expect(mantleRoute("openai.gpt-oss-120b", mantle).baseUrl).toBe(
			"https://bedrock-mantle.eu-central-1.api.aws/openai/v1",
		);
		expect(mantleRoute("anthropic.claude-fable-5", mantle)).toEqual({
			api: "anthropic-messages",
			baseUrl: "https://bedrock-mantle.eu-central-1.api.aws/anthropic",
		});
	});

	test("an unknown host uses the API the user picked, Converse without a pick", () => {
		const url = "https://llm.corp.example/v1";
		expect(bedrockRoute(model("m", url), { OCTOCODE_ENDPOINT_API: "openai-completions" }).api).toBe(
			"openai-completions",
		);
		expect(bedrockRoute(model("m", url), undefined).api).toBe("bedrock-converse-stream");
	});

	test("a stored endpoint becomes the request base URL and region", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("amazon-bedrock", async () => ({
			type: "api_key",
			key: "k",
			endpoint: { baseUrl: mantle, region: "eu-central-1" },
		}));
		const context: AuthContext = { env: async () => undefined, fileExists: async () => false };
		const resolved = await resolveProviderAuth(amazonBedrockProvider(), store, context);
		expect(resolved?.auth.baseUrl).toBe(mantle);
		expect(resolved?.env?.AWS_REGION).toBe("eu-central-1");
	});

	test("a stored AWS profile outranks an AWS_BEARER_TOKEN_BEDROCK in the environment", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("amazon-bedrock", async () => ({ type: "api_key", env: { AWS_PROFILE: "work" } }));
		const context: AuthContext = {
			env: async (name) => (name === "AWS_BEARER_TOKEN_BEDROCK" ? "bearer" : undefined),
			fileExists: async () => false,
		};
		const resolved = await resolveProviderAuth(amazonBedrockProvider(), store, context);
		expect(resolved?.source).toBe("stored credential");
		expect(resolved?.env?.AWS_PROFILE).toBe("work");
	});

	test("host validation: https or localhost only, no embedded credentials", () => {
		expect(normalizeEndpointHost("llm.corp.example/v1/")).toBe("https://llm.corp.example/v1");
		expect(normalizeEndpointHost("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
		expect(() => normalizeEndpointHost("http://llm.corp.example")).toThrow(/https/);
		expect(() => normalizeEndpointHost("https://user:pw@llm.corp.example")).toThrow(/user, password/);
		expect(() => normalizeEndpointHost("")).toThrow(/empty/);
	});
});

describe("the host a provider's key can be saved with", () => {
	test("official providers that accept a base URL declare it; the others do not", () => {
		expect(amazonBedrockProvider().auth?.apiKey?.host?.region).toBe(true);
		expect(anthropicProvider().auth?.apiKey?.host?.example).toMatch(/^https:\/\//);
		expect(openaiProvider().auth?.apiKey?.host?.example).toMatch(/^https:\/\//);
	});

	test("bedrock: the host name picks the API, an unknown host must say which, mantle needs a bearer token", () => {
		expect(bedrockEndpoint({ host: mantle, region: " eu-central-1 " }, "bearer-token")).toEqual({
			baseUrl: mantle,
			region: "eu-central-1",
		});
		expect(() => bedrockEndpoint({ host: "https://llm.corp.example/v1" }, "bearer-token")).toThrow(/API/);
		expect(bedrockEndpoint({ host: "https://llm.corp.example/v1", api: "openai-completions" }, "bearer-token")).toEqual(
			{
				baseUrl: "https://llm.corp.example/v1",
				api: "openai-completions",
			},
		);
		expect(() => bedrockEndpoint({ host: "https://llm.corp.example/v1", api: "nope" }, "bearer-token")).toThrow(/API/);
		expect(() => bedrockEndpoint({ host: mantle }, "aws-profile")).toThrow(/bearer token/);
		expect(bedrockEndpoint({ host: "" }, "bearer-token")).toBeUndefined();
		expect(() => bedrockEndpoint({ host: "http://llm.corp.example" }, "bearer-token")).toThrow(/https/);
	});
});
