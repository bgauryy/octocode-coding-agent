import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

const mockState = { headers: undefined as Headers | undefined, body: undefined as Record<string, unknown> | undefined };

beforeEach(() => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
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

describe("Copilot Claude via Anthropic Messages", () => {
	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});

	it("applies Copilot-specific adaptive thinking effort overrides", () => {
		const opus48 = getBuiltinModel("github-copilot", "claude-opus-4.8");
		expect(opus48.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });
		expect(getSupportedThinkingLevels(opus48)).toContain("xhigh");
		expect(getSupportedThinkingLevels(opus48)).toContain("max");

		const opus5 = getBuiltinModel("github-copilot", "claude-opus-5");
		expect(opus5.api).toBe("anthropic-messages");
		expect(opus5.contextWindow).toBe(1000000);
		expect(opus5.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });
		expect(getSupportedThinkingLevels(opus5)).toContain("xhigh");
		expect(getSupportedThinkingLevels(opus5)).toContain("max");

		const opus55 = getBuiltinModel("github-copilot", "claude-opus-5.5");
		expect(opus55.api).toBe("anthropic-messages");
		expect(opus55.contextWindow).toBe(1000000);
		expect(getSupportedThinkingLevels(opus55)).toEqual(["low", "medium", "high", "xhigh", "max"]);

		const sonnet46 = getBuiltinModel("github-copilot", "claude-sonnet-4.6");
		expect(sonnet46.thinkingLevelMap).toMatchObject({ minimal: "low", max: "max" });
		expect(getSupportedThinkingLevels(sonnet46)).toContain("max");
		expect(getSupportedThinkingLevels(sonnet46)).not.toContain("xhigh");
	});

	it("uses Bearer auth, Copilot headers, and valid Anthropic Messages payload", async () => {
		const model = getBuiltinModel("github-copilot", "claude-sonnet-4.6");
		expect(model.api).toBe("anthropic-messages");

		const s = streamAnthropic(model, context, { apiKey: "tid_copilot_session_test_token" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const headers = mockState.headers!;
		expect(headers).toBeDefined();
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.get("authorization")).toBe("Bearer tid_copilot_session_test_token");

		// Copilot static headers from model.headers
		expect(headers.get("user-agent")).toContain("GitHubCopilotChat");
		expect(headers.get("copilot-integration-id")).toBe("vscode-chat");

		// Dynamic headers
		expect(headers.get("x-initiator")).toBe("user");
		expect(headers.get("openai-intent")).toBe("conversation-edits");

		// Payload is valid Anthropic Messages format
		const params = mockState.body!;
		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
		expect(params.model).toBe("claude-sonnet-4.6");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBe(model.maxTokens);
		expect(Array.isArray(params.messages)).toBe(true);
	});

	it("omits interleaved-thinking beta for adaptive-thinking models", async () => {
		const model = getBuiltinModel("github-copilot", "claude-sonnet-4.6");
		const s = streamAnthropic(model, context, {
			apiKey: "tid_copilot_session_test_token",
			interleavedThinking: true,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(mockState.headers?.get("anthropic-beta")?.split(",") ?? []).not.toContain("interleaved-thinking-2025-05-14");
	});
});
