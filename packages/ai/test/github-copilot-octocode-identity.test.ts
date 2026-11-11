import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import type { AuthEvent, OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import { setUserAgentVersion } from "../src/utils/user-agent.ts";

const neverAbortedSignal = new AbortController().signal;
const CLIENT_ID = "Ov23-test-octocode-app";
const ACCOUNT_API = "https://api.individual.githubcopilot.com";
const LEGACY_TOKEN = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";

interface Captured {
	url: string;
	headers: Headers;
	body?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function stubFetch(user: unknown, modelIds: readonly string[]): Captured[] {
	const captured: Captured[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = urlOf(input);
			captured.push({ url, headers: new Headers(init?.headers), body: init?.body?.toString() });
			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 900,
				});
			}
			if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "gho_octocode_token" });
			if (url === "https://api.github.com/copilot_internal/user") return jsonResponse(user);
			if (url === `${ACCOUNT_API}/models`) {
				return jsonResponse({
					data: modelIds.map((id) => ({
						id,
						model_picker_enabled: true,
						capabilities: { supports: { tool_calls: true } },
					})),
				});
			}
			return jsonResponse({ error: { message: "stop here" } }, 400);
		}),
	);
	return captured;
}

async function login(events: AuthEvent[] = []): Promise<OAuthCredential> {
	vi.useFakeTimers();
	const pending = githubCopilotOAuth.login({
		signal: neverAbortedSignal,
		prompt: async () => "",
		notify: (event) => events.push(event),
	});
	// Settle before the timers run, so a refused login is not an unhandled rejection.
	const settled = pending.then(
		(credential) => ({ credential }),
		(error: unknown) => ({ error }),
	);
	await vi.advanceTimersByTimeAsync(1000);
	const result = await settled;
	if ("error" in result) throw result.error;
	return result.credential;
}

function expectOctocodeIdentity(headers: Headers): void {
	expect(headers.get("user-agent")).toMatch(/^octocode\/1\.3\.0 /);
	expect(headers.get("editor-version")).toBeNull();
	expect(headers.get("editor-plugin-version")).toBeNull();
	expect(headers.get("copilot-integration-id")).toBeNull();
	expect(headers.get("originator")).not.toBe("pi");
}

async function streamWith(
	credential: OAuthCredential,
	extraHeaders?: { model?: Record<string, string>; request?: Record<string, string> },
): Promise<void> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("github-copilot", async () => credential);
	const models = createModels({ credentials });
	const provider = githubCopilotProvider();
	models.setProvider(provider);
	const builtIn = provider.getModels().find((entry) => entry.api === "openai-completions")!;
	const model = extraHeaders?.model ? { ...builtIn, headers: { ...builtIn.headers, ...extraHeaders.model } } : builtIn;
	await models
		.stream(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
			extraHeaders?.request ? { headers: extraHeaders.request } : undefined,
		)
		.result();
}

describe("GitHub Copilot through an Octocode GitHub app", () => {
	afterEach(() => {
		setUserAgentVersion(undefined);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("shows GitHub's terms and says official support is OpenCode-only before signing in", async () => {
		stubFetch({}, []);
		const events: AuthEvent[] = [];
		// The VS Code client's token exchange is refused by the stub; only the notice before it matters here.
		await expect(login(events)).rejects.toThrow("HTTP 400");
		const notice = events.find((event) => event.type === "info");
		expect(notice?.type === "info" && notice.message).toContain("only for OpenCode");
		expect(notice?.type === "info" && notice.message).toContain("VS Code Copilot Chat client");
		expect(notice?.type === "info" && notice.links?.map((link) => link.url)).toContain(
			"https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies",
		);
	});

	it("signs in with the configured app, checks the entitlement and uses the GitHub token directly", async () => {
		vi.stubEnv("OCTOCODE_COPILOT_CLIENT_ID", CLIENT_ID);
		setUserAgentVersion("1.3.0");
		const modelId = githubCopilotProvider().getModels()[0].id;
		const captured = stubFetch({ chat_enabled: true, endpoints: { api: `${ACCOUNT_API}/` } }, [modelId]);

		const credential = await login();

		expect(captured.some((request) => request.url.includes("/copilot_internal/v2/token"))).toBe(false);
		const device = captured.find((request) => request.url.endsWith("/login/device/code"))!;
		expect(new URLSearchParams(device.body).get("client_id")).toBe(CLIENT_ID);
		for (const request of captured) expectOctocodeIdentity(request.headers);
		expect(credential).toMatchObject({
			identity: "octocode",
			clientId: CLIENT_ID,
			access: "gho_octocode_token",
			apiEndpoint: ACCOUNT_API,
			availableModelIds: [modelId],
		});
		expect(await githubCopilotOAuth.toAuth(credential)).toMatchObject({
			apiKey: "gho_octocode_token",
			baseUrl: ACCOUNT_API,
		});

		captured.length = 0;
		await streamWith(credential);
		const chat = captured.find((request) => request.url.startsWith(`${ACCOUNT_API}/chat/completions`));
		expect(chat).toBeDefined();
		expectOctocodeIdentity(chat!.headers);
		expect(chat!.headers.get("authorization")).toBe("Bearer gho_octocode_token");
	});

	it("refuses an account without Copilot, naming what it needs", async () => {
		vi.stubEnv("OCTOCODE_COPILOT_CLIENT_ID", CLIENT_ID);
		stubFetch({ chat_enabled: false, can_signup_for_limited: true }, []);
		await expect(login()).rejects.toThrow("not signed up for GitHub Copilot");
	});

	it("re-checks an Octocode credential on refresh and keeps its token", async () => {
		vi.stubEnv("OCTOCODE_COPILOT_CLIENT_ID", CLIENT_ID);
		setUserAgentVersion("1.3.0");
		const captured = stubFetch({ chat_enabled: true }, ["gpt-test"]);
		const refreshed = await githubCopilotOAuth.refresh(
			{ type: "oauth", identity: "octocode", access: "gho_t", refresh: "gho_t", expires: 0, apiEndpoint: ACCOUNT_API },
			neverAbortedSignal,
		);
		expect(refreshed).toMatchObject({
			access: "gho_t",
			refresh: "gho_t",
			apiEndpoint: ACCOUNT_API,
			availableModelIds: ["gpt-test"],
		});
		expect(refreshed.expires).toBeGreaterThan(Date.now());
		expect(captured.some((request) => request.url.includes("/copilot_internal/v2/token"))).toBe(false);
	});

	it("keeps today's VS Code client requests unchanged when no app is configured", async () => {
		const captured = stubFetch({}, []);
		await streamWith({ type: "oauth", access: LEGACY_TOKEN, refresh: "ghu_refresh", expires: Date.now() + 3_600_000 });
		const chat = captured.find((request) => request.url.includes("/chat/completions"));
		expect(chat?.headers.get("copilot-integration-id")).toBe("vscode-chat");
		expect(chat?.headers.get("editor-version")).toBe("vscode/1.107.0");
	});

	it.each(["model", "request"] as const)(
		"keeps the VS Code client's identity when a %s header names the API version",
		async (where) => {
			const captured = stubFetch({}, []);
			await streamWith(
				{ type: "oauth", access: LEGACY_TOKEN, refresh: "ghu_refresh", expires: Date.now() + 3_600_000 },
				{ [where]: { "X-GitHub-Api-Version": "2025-01-01" } },
			);
			const chat = captured.find((request) => request.url.includes("/chat/completions"));
			expect(chat?.headers.get("copilot-integration-id")).toBe("vscode-chat");
			expect(chat?.headers.get("editor-version")).toBe("vscode/1.107.0");
			expect(chat?.headers.get("x-github-api-version")).toBe("2025-01-01");
		},
	);
});
