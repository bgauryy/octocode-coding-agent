import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { federationToken, getAnthropicFederation } from "../src/api/anthropic-messages/federation.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Runs the real Anthropic SDK against a fake fetch to check how often the
// workload identity federation token exchange happens.

function sseResponse(): Response {
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

interface RecordedRequest {
	path: string;
	authorization: string | null;
}

function createFetch(requests: RecordedRequest[]): typeof globalThis.fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		requests.push({ path, authorization: request.headers.get("authorization") });
		if (path === "/v1/oauth/token") {
			return new Response(JSON.stringify({ access_token: "federated-token", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return sseResponse();
	};
}

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

let tempDir: string;
let federationEnv: Record<string, string>;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "octocode-anthropic-federation-"));
	const identityTokenFile = join(tempDir, "identity.jwt");
	writeFileSync(identityTokenFile, "header.payload.signature");
	federationEnv = {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
		ANTHROPIC_ORGANIZATION_ID: "org-test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
	};
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Anthropic workload identity federation with the SDK", () => {
	it("exchanges the identity token once across requests", async () => {
		const requests: RecordedRequest[] = [];
		const fetch = createFetch(requests);

		for (let i = 0; i < 3; i++) {
			const message = await streamAnthropic(anthropicModel, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
		}

		expect(requests.filter((request) => request.path === "/v1/oauth/token")).toHaveLength(1);
		const messageRequests = requests.filter((request) => request.path === "/v1/messages");
		expect(messageRequests).toHaveLength(3);
		for (const request of messageRequests) {
			expect(request.authorization).toBe("Bearer federated-token");
		}
	});

	it("coalesces concurrent initial and mandatory refresh requests", async () => {
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ access_token: `token-${++calls}`, expires_in: 3600, token_type: "Bearer" }),
		);
		const config = getAnthropicFederation(anthropicModel, undefined, undefined, federationEnv)!;
		const token = federationToken(anthropicModel, config, fetch);
		expect(await Promise.all([token(), token(), token()])).toEqual(["token-1", "token-1", "token-1"]);
		expect(fetch).toHaveBeenCalledTimes(1);
		now += 3_580_000;
		expect(await Promise.all([token(), token()])).toEqual(["token-2", "token-2"]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("rejects an oversized identity file before any token exchange", async () => {
		const path = join(tempDir, "oversized.jwt");
		writeFileSync(path, "x".repeat(16 * 1024 + 1));
		const config = getAnthropicFederation(anthropicModel, undefined, undefined, {
			...federationEnv,
			ANTHROPIC_IDENTITY_TOKEN_FILE: path,
		})!;
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(federationToken(anthropicModel, config, fetch)()).rejects.toThrow("16 KiB assertion limit");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("rejects unsupported token types and oversized token responses", async () => {
		const config = getAnthropicFederation(anthropicModel, undefined, undefined, federationEnv)!;
		const invalid = federationToken(anthropicModel, config, async () =>
			Response.json({ access_token: "secret", expires_in: 3600, token_type: "Basic" }),
		);
		await expect(invalid()).rejects.toThrow("unsupported token type");
		const oversized = federationToken(anthropicModel, config, async () => new Response("x".repeat(1024 * 1024 + 1)));
		await expect(oversized()).rejects.toThrow("exceeds 1 MiB");
	});
	it("does not run the SDK credential chain for header-owned auth", async () => {
		for (const [name, value] of Object.entries(federationEnv)) vi.stubEnv(name, value);
		const requests: RecordedRequest[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			headers: { Authorization: "Bearer auth-token" },
			fetch: createFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toEqual([{ path: "/v1/messages", authorization: "Bearer auth-token" }]);
	});
});
