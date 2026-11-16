import { mkdtempSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({
	calls: [] as Record<string, unknown>[],
	requests: [] as { url: string; headers: Headers }[],
}));
const { GoogleAuth, JWT, UserRefreshClient, BaseExternalAccountClient, Impersonated } = createRequire(import.meta.url)(
	"google-auth-library",
);
vi.spyOn(GoogleAuth.prototype, "getClient").mockImplementation(async function (this: {
	projectId?: string;
	cachedCredential?: unknown;
}) {
	auth.calls.push(this);
	return { getAccessToken: async () => ({ token: "mock-adc-token" }) };
});
import { stream } from "../src/api/google-vertex.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
const model = getBuiltinModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const adc = { project: "test-project", location: "us-central1" };
mockCompletionsFetch((_params, request, url) => {
	auth.requests.push({ url, headers: new Headers(request.headers) });
	return completionsResponse([
		{
			responseId: "vertex-response-id",
			candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		},
	]);
});
beforeEach(() => {
	auth.calls.length = 0;
	auth.requests.length = 0;
});
function expectAdc(location = adc.location) {
	expect(auth.requests).toHaveLength(1);
	expect(auth.requests[0].headers.get("authorization")).toBe("Bearer mock-adc-token");
	expect(auth.requests[0].headers.has("x-goog-api-key")).toBe(false);
	expect(auth.requests[0].url).toBe(
		`https://${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com/v1/projects/test-project/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`,
	);
	expect(auth.calls).toHaveLength(1);
}
describe("google-vertex location", () => {
	it("refuses a location that is not a region id, so the bearer token never leaves the Google host", async () => {
		const result = await stream(model, context, { ...adc, location: "evil.example/#" }).result();
		expect(auth.requests).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("GOOGLE_CLOUD_LOCATION");
	});
	it("accepts region ids and global", async () => {
		for (const location of ["us-central1", "europe-west4", "global"]) {
			auth.requests.length = 0;
			auth.calls.length = 0;
			const result = await stream(model, context, { ...adc, location }).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expectAdc(location);
		}
	});
});
describe("google-vertex api key resolution", () => {
	it.each([
		["options.apiKey is a placeholder marker", "<authenticated>"],
		["options.apiKey is the gcp-vertex-credentials marker", "gcp-vertex-credentials"],
	])("falls back to ADC when %s", async (_name, apiKey) => {
		await stream(model, context, { ...adc, apiKey }).result();
		expectAdc();
	});
	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		await stream(model, context, { ...adc, env: { GOOGLE_CLOUD_API_KEY: "<authenticated>" } }).result();
		expectAdc();
	});
	it("still uses the API key client for real API keys", async () => {
		await stream(model, context, { apiKey: "test-real-key" }).result();
		expect(auth.requests).toHaveLength(1);
		expect(auth.requests[0].url).toBe(
			`https://aiplatform.googleapis.com/v1/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`,
		);
		expect(auth.requests[0].headers.get("x-goog-api-key")).toBe("test-real-key");
		expect(auth.requests[0].headers.has("authorization")).toBe(false);
	});
	it("does not forward generated Vertex base URL placeholders", async () => {
		await stream(model, context, adc).result();
		expectAdc();
		expect(auth.requests[0].headers.get("user-agent")).toBe(`octocode (${platform()} ${release()}; ${arch()})`);
	});
	it("lets explicit headers override the default User-Agent", async () => {
		await stream(model, context, { ...adc, headers: { "User-Agent": "custom-agent" } }).result();
		expectAdc();
		expect(auth.requests[0].headers.get("user-agent")).toBe("custom-agent");
	});
	it("forwards custom baseUrl to the ADC client", async () => {
		await stream({ ...model, baseUrl: "https://proxy.example.com" }, context, adc).result();
		expect(auth.requests).toHaveLength(1);
		expect(auth.requests[0].headers.get("authorization")).toBe("Bearer mock-adc-token");
		expect(auth.requests[0].url).toBe(`https://proxy.example.com/v1/models/${model.id}:streamGenerateContent?alt=sse`);
	});
	it("forwards custom baseUrl to the API key client", async () => {
		await stream({ ...model, baseUrl: "https://proxy.example.com" }, context, { apiKey: "test-real-key" }).result();
		expect(auth.requests).toHaveLength(1);
		expect(auth.requests[0].url).toBe(`https://proxy.example.com/v1/models/${model.id}:streamGenerateContent?alt=sse`);
		expect(auth.requests[0].headers.get("x-goog-api-key")).toBe("test-real-key");
	});
	it("does not append apiVersion when custom baseUrl already includes one", async () => {
		await stream(
			{ ...model, baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global" },
			context,
			adc,
		).result();
		expect(auth.requests).toHaveLength(1);
		expect(auth.requests[0].url).toBe(
			`https://proxy.example.com/v1/projects/test-project/locations/global/models/${model.id}:streamGenerateContent?alt=sse`,
		);
	});
	it("passes explicit ADC credentials and environment project/location", async () => {
		const path = credentialsFile({ type: "service_account", client_email: "scoped@example.iam", private_key: "k" });
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsFile({
			type: "service_account",
			client_email: "global@example.iam",
			private_key: "k",
		});
		try {
			await stream(model, context, {
				env: {
					GOOGLE_APPLICATION_CREDENTIALS: path,
					GOOGLE_CLOUD_PROJECT: adc.project,
					GOOGLE_CLOUD_LOCATION: adc.location,
				},
			}).result();
		} finally {
			delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		}
		expectAdc();
		const client = auth.calls[0].cachedCredential;
		expect(client).toBeInstanceOf(JWT);
		expect(client).toMatchObject({ email: "scoped@example.iam" });
	});

	it("builds a user refresh client from authorized_user credentials", async () => {
		const path = credentialsFile({ type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" });
		await stream(model, context, { ...adc, env: { GOOGLE_APPLICATION_CREDENTIALS: path } }).result();
		expectAdc();
		expect(auth.calls[0].cachedCredential).toBeInstanceOf(UserRefreshClient);
		expect(auth.requests[0].headers.has("x-goog-user-project")).toBe(false);
	});

	it("sends the credentials file's quota project as x-goog-user-project, overridable by the environment", async () => {
		const path = credentialsFile({
			type: "authorized_user",
			client_id: "id",
			client_secret: "s",
			refresh_token: "r",
			quota_project_id: "billing-project",
		});
		await stream(model, context, { ...adc, env: { GOOGLE_APPLICATION_CREDENTIALS: path } }).result();
		expect(auth.requests[0].headers.get("x-goog-user-project")).toBe("billing-project");
		expect(auth.calls[0].cachedCredential).toMatchObject({ quotaProjectId: "billing-project" });
		auth.requests.length = 0;
		await stream(model, context, {
			...adc,
			env: { GOOGLE_APPLICATION_CREDENTIALS: path, GOOGLE_CLOUD_QUOTA_PROJECT: "env-project" },
		}).result();
		expect(auth.requests[0].headers.get("x-goog-user-project")).toBe("env-project");
	});

	it("builds clients for external_account and impersonated_service_account credentials", async () => {
		const external = credentialsFile({
			type: "external_account",
			audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
			subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
			token_url: "https://sts.googleapis.com/v1/token",
			credential_source: { file: "/var/run/token" },
		});
		await stream(model, context, { ...adc, env: { GOOGLE_APPLICATION_CREDENTIALS: external } }).result();
		expect(auth.calls[0].cachedCredential).toBeInstanceOf(BaseExternalAccountClient);
		const impersonated = credentialsFile({
			type: "impersonated_service_account",
			service_account_impersonation_url:
				"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@example.iam:generateAccessToken",
			source_credentials: { type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" },
		});
		await stream(model, context, { ...adc, env: { GOOGLE_APPLICATION_CREDENTIALS: impersonated } }).result();
		const client = auth.calls[1].cachedCredential;
		expect(client).toBeInstanceOf(Impersonated);
		expect(client).toMatchObject({ targetPrincipal: "target@example.iam" });
	});

	it("uses ADC discovery when no credentials file is set", async () => {
		await stream(model, context, adc).result();
		expectAdc();
		expect(auth.calls[0].cachedCredential).toBeNull();
	});

	it("rejects unsupported or unreadable credentials without echoing their contents", async () => {
		const unknown = credentialsFile({ type: "gdch_service_account", private_key: "secret-key" });
		const impersonatedLoop = credentialsFile({
			type: "impersonated_service_account",
			service_account_impersonation_url: "https://x/serviceAccounts/a:generateAccessToken",
			source_credentials: { type: "impersonated_service_account", secret: "secret-inner" },
		});
		const broken = join(mkdtempSync(join(tmpdir(), "vertex-auth-")), "bad.json");
		writeFileSync(broken, "not-json secret-body");
		for (const [path, message] of [
			[unknown, 'credentials type "gdch_service_account" is not supported'],
			[impersonatedLoop, "impersonated credentials need source_credentials"],
			[broken, "is missing or not valid JSON"],
			["/missing/credentials.json", "is missing or not valid JSON"],
		]) {
			const result = await stream(model, context, { ...adc, env: { GOOGLE_APPLICATION_CREDENTIALS: path } }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(message);
			expect(result.errorMessage).not.toContain("secret");
		}
		expect(auth.requests).toHaveLength(0);
	});
});

function credentialsFile(credentials: Record<string, unknown>): string {
	const path = join(mkdtempSync(join(tmpdir(), "vertex-auth-")), "credentials.json");
	writeFileSync(path, JSON.stringify(credentials));
	return path;
}
