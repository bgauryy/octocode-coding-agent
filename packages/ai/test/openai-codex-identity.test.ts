import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSSEHeaders, buildWebSocketHeaders } from "../src/api/openai-codex-responses/request.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { createModels } from "../src/models.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { getUserAgent, setUserAgentVersion } from "../src/utils/user-agent.ts";

const neverAbortedSignal = new AbortController().signal;

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function expectHonest(headers: Headers): void {
	expect(headers.get("originator")?.toLowerCase()).not.toBe("pi");
	expect(headers.get("user-agent")).toMatch(/^octocode\//);
}

describe("Octocode identity on requests", () => {
	afterEach(() => {
		setUserAgentVersion(undefined);
		vi.unstubAllGlobals();
	});

	it("names Octocode and the host's version in the User-Agent", () => {
		expect(getUserAgent()).toMatch(/^octocode \(/);
		setUserAgentVersion("1.3.0");
		expect(getUserAgent()).toMatch(/^octocode\/1\.3\.0 \(/);
		expect(getUserAgent()).not.toMatch(/^pi\b/);
	});

	it("sends Octocode as the Codex originator when the credential names none", () => {
		setUserAgentVersion("1.3.0");
		const token = createAccessToken("acct");
		for (const headers of [
			buildSSEHeaders(undefined, undefined, "acct", token),
			buildWebSocketHeaders(undefined, undefined, "acct", token, "request-id"),
		]) {
			expect(headers.get("originator")).toBe("Octocode");
			expectHonest(headers);
		}
	});

	it("sends the originator the login named on every Codex request", async () => {
		setUserAgentVersion("1.3.0");
		const requests: Headers[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				requests.push(new Headers(init?.headers));
				return jsonResponse({ error: { message: "stop here" } }, 400);
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access: createAccessToken("acct"),
			refresh: "refresh",
			expires: Date.now() + 60 * 60_000,
			originator: "octocode",
		}));
		const models = createModels({ credentials });
		const provider = openaiCodexProvider();
		models.setProvider(provider);
		const model = provider.getModels()[0];
		const result = await models
			.stream(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }, { transport: "sse" })
			.result();

		expect(result.stopReason).toBe("error");
		expect(requests.length).toBeGreaterThan(0);
		for (const headers of requests) {
			expect(headers.get("originator")).toBe("octocode");
			expectHonest(headers);
		}
	});

	it("keeps the login's originator on the credential through login and refresh", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ access_token: createAccessToken("acct"), refresh_token: "refresh", expires_in: 3600 }),
			),
		);
		let authUrl = "";
		const notices: string[] = [];
		const credential = await openaiCodexOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
				if (event.type === "info") notices.push(event.message);
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				const state = new URL(authUrl).searchParams.get("state");
				return `http://localhost:1455/auth/callback?code=pasted-code&state=${state}`;
			},
		});

		expect(new URL(authUrl).searchParams.get("originator")).toBe("Octocode");
		expect(notices.join("\n")).toContain("/providers openai");
		expect(credential.originator).toBe("Octocode");
		expect(await openaiCodexOAuth.toAuth(credential)).toMatchObject({ headers: { originator: "Octocode" } });
		const refreshed = await openaiCodexOAuth.refresh(credential, neverAbortedSignal);
		expect(refreshed.originator).toBe("Octocode");
	});
});
