import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import {
	formatAuthExpiredMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
} from "../src/core/auth-guidance.ts";

describe("auth guidance", () => {
	it("inside a session leads with the action and keeps the docs on one line", () => {
		const message = formatNoModelsAvailableMessage();
		expect(message).toMatch(/^No AI provider connected yet\. Type \/login to connect one/);
		expect(message).toMatch(/\nDocs: providers\.md · models\.md in /);
		expect(formatNoApiKeyFoundMessage("openai")).toMatch(/^No API key found for openai\. Type \/login/);
		expect(formatNoModelSelectedMessage()).toContain("Then /model to pick a model.");
	});

	it("on the command line says how to reach /login and offers an environment variable", () => {
		const message = formatNoModelsAvailableMessage("cli");
		expect(message).toContain(`Run \`${APP_NAME}\` and type /login`);
		expect(message).toContain("API key environment variable");
		expect(message).toContain("models.md");
	});

	it("tells an expired sign-in what to do", () => {
		expect(formatAuthExpiredMessage("anthropic")).toBe(
			"Sign-in for anthropic failed: the credentials may have expired, or the network is down. Type /login anthropic to sign in again.",
		);
	});
});
