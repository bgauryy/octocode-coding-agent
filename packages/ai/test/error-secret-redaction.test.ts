import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	formatProviderError,
	MAX_AUTH_ERROR_BODY_CHARS,
	normalizeProviderError,
	setProviderTextRedactor,
} from "../src/utils/error-body.ts";

/** A synthetic key no pattern recognizes: the case exact-value redaction exists for. */
const KEY = "synthetic0123456789abcdef0123456789";

const redactKey = (text: string): string => text.replaceAll(KEY, "[redacted]");

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
const signal = new AbortController().signal;

/** The error a sign-in call rejects with; fails the test when it resolves. */
async function rejection(call: Promise<unknown>): Promise<Error> {
	const outcome = await call.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(outcome).toBeInstanceOf(Error);
	return outcome as Error;
}

let server: Server | undefined;

async function serve(status: number, body: string): Promise<string> {
	server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function failure(events: AsyncIterable<unknown> & { result(): Promise<AssistantMessage> }): Promise<string> {
	for await (const _event of events) {
		// Drain the stream to its end.
	}
	const message = await events.result();
	expect(message.stopReason).toBe("error");
	return message.errorMessage ?? "";
}

const anthropicModel = (baseUrl: string): Model<"anthropic-messages"> => ({
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "test-anthropic",
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
});

const completionsModel = (baseUrl: string): Model<"openai-completions"> => ({
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "test-openai",
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 1024,
});

describe("credentials in provider and sign-in error text", () => {
	beforeEach(() => setProviderTextRedactor(redactKey));
	afterEach(async () => {
		setProviderTextRedactor(undefined);
		vi.unstubAllGlobals();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	it("keeps the key out of an Anthropic error message", async () => {
		const baseUrl = await serve(401, JSON.stringify({ type: "error", error: { message: `invalid x-api-key ${KEY}` } }));
		const message = await failure(streamAnthropic(anthropicModel(baseUrl), context, { apiKey: KEY }));
		expect(message).toContain("401");
		expect(message).not.toContain(KEY);
	});

	it("keeps the key out of an OpenAI-compatible error message", async () => {
		const baseUrl = await serve(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }));
		const message = await failure(streamOpenAICompletions(completionsModel(baseUrl), context, { apiKey: KEY }));
		expect(message).toContain("401");
		expect(message).not.toContain(KEY);
	});

	it("keeps the key out of a setup failure message", async () => {
		const model = completionsModel("http://127.0.0.1:1");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(`connect failed with header Authorization: ${KEY}`);
			}),
		);
		const events = streamOpenAICompletions(model, context, { apiKey: KEY });
		const message = await failure(events);
		expect(message).not.toContain(KEY);
	});

	it("redacts the message and the body of an SDK error, and the string a non-Error throw becomes", () => {
		const sdkError = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: { detail: `bad credential ${KEY}` },
		});
		const shown = formatProviderError(normalizeProviderError(sdkError));
		expect(shown).toContain("403");
		expect(shown).toContain("[redacted]");
		expect(shown).not.toContain(KEY);
		expect(normalizeProviderError({ key: KEY }).message).not.toContain(KEY);
		expect(JSON.stringify(normalizeProviderError(new Error(`quoted ${KEY}`)))).not.toContain(KEY);
	});

	it("redacts a key before an oversized body is cut, so a cut cannot leave half of it", () => {
		const padding = "x ".repeat(1990);
		const body = `${padding}${KEY}${" y".repeat(100)}`;
		const shown = formatProviderError(normalizeProviderError(Object.assign(new Error("500"), { status: 500, body })));
		expect(shown).not.toContain(KEY.slice(0, 12));
	});

	it("leaves error text unchanged when no redactor is installed", () => {
		setProviderTextRedactor(undefined);
		expect(normalizeProviderError(new Error(`plain ${KEY}`)).message).toContain(KEY);
	});

	it("summarizes a Kimi device authorization failure without the key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`echo ${KEY} ${"z".repeat(5000)}`, { status: 400 })),
		);
		const interaction = { signal, prompt: async () => "", notify: () => undefined };
		const error = await rejection(kimiCodingOAuth.login(interaction));
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("status 400");
		expect(error.message).not.toContain(KEY);
		expect(error.message.length).toBeLessThan(MAX_AUTH_ERROR_BODY_CHARS + 200);
	});

	it("names only the error fields of a failed Kimi token refresh", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "server_error", error_description: "try later", refresh_token: KEY }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);
		const error = await rejection(
			kimiCodingOAuth.refresh({ type: "oauth", access: "old", refresh: "old", expires: 0 }, signal),
		);
		expect(error.message).toContain("server_error: try later");
		expect(error.message).not.toContain(KEY);
	});

	it("keeps the key out of a Copilot model catalog failure", async () => {
		const accessToken = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = String(input);
				if (url.includes("/copilot_internal/v2/token")) {
					return new Response(JSON.stringify({ token: accessToken, expires_at: 9999999999 }), { status: 200 });
				}
				return new Response(`denied for ${KEY}`, { status: 403, statusText: "Forbidden" });
			}),
		);
		const error = await rejection(
			githubCopilotOAuth.refresh({ type: "oauth", access: "old", refresh: "ghu_refresh_token", expires: 0 }, signal),
		);
		expect(error.message).toContain("403");
		expect(error.message).not.toContain(KEY);
	});
});
