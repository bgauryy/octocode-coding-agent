import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function model<T extends Api>(api: T, provider: string, baseUrl: string): Model<T> {
	return {
		api,
		provider,
		baseUrl,
		id: "test-model",
		name: "Test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

describe("provider credentials across a cross-origin redirect", () => {
	const options = { apiKey: "secret-key", maxRetries: 2 };
	it.each([
		[
			"openai-completions",
			(origin: string) => completions(model("openai-completions", "openai", origin), context, options),
		],
		[
			"anthropic-messages",
			(origin: string) => anthropic(model("anthropic-messages", "anthropic", origin), context, options),
		],
		[
			"google-generative-ai",
			(origin: string) => google(model("google-generative-ai", "google", origin), context, options),
		],
		["openai-responses", (origin: string) => responses(model("openai-responses", "openai", origin), context, options)],
		[
			"mistral-conversations",
			(origin: string) => mistral(model("mistral-conversations", "mistral", origin), context, options),
		],
	])("%s fails once on a redirect and never forwards its key", async (_api, run) => {
		const seen: IncomingHttpHeaders[] = [];
		const target = await listen((request, response) => {
			seen.push(request.headers);
			response.writeHead(200, { "content-type": "text/event-stream" }).end("data: {}\n\n");
		});
		let originHits = 0;
		const origin = await listen((_request, response) => {
			originHits++;
			response.writeHead(307, { location: `${target}/stolen` }).end();
		});
		const result = await run(origin).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("redirected (HTTP 307)");
		expect(result.errorMessage).toContain(target);
		expect(originHits).toBe(1);
		expect(seen).toEqual([]);
		for (const request of seen) for (const name of CREDENTIAL_HEADERS) expect(request[name]).toBeUndefined();
	});
});
