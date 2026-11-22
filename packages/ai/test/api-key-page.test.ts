import { describe, expect, it } from "vitest";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";

describe("API-key sign-in key pages", () => {
	it.each([
		["OpenAI", openaiProvider, "https://platform.openai.com/api-keys"],
		["OpenCode Zen", opencodeProvider, "https://opencode.ai/console"],
		["OpenCode Go", opencodeGoProvider, "https://opencode.ai/console"],
	])("%s opens the page that issues keys before asking for one", async (name, provider, url) => {
		const order: string[] = [];
		const events: AuthEvent[] = [];
		expect(provider().auth.apiKey?.keyPage).toBe(url);
		const credential = await provider().auth.apiKey!.login!({
			signal: new AbortController().signal,
			notify: (event) => {
				order.push(event.type);
				events.push(event);
			},
			prompt: async (prompt: AuthPrompt) => {
				order.push(prompt.type);
				return prompt.type === "secret" ? "sk-test" : "";
			},
		});
		expect(order).toEqual(name === "OpenAI" ? ["auth_url", "secret", "text"] : ["auth_url", "secret"]);
		expect(events[0]).toMatchObject({ type: "auth_url", url });
		expect(credential).toEqual({ type: "api_key", key: "sk-test" });
	});
});
