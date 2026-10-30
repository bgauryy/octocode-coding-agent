import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { formatNoApiKeyFoundMessage, formatNoModelsAvailableMessage } from "../src/core/auth-guidance.ts";

describe("auth guidance", () => {
	it("inside a session points at /login", () => {
		const message = formatNoModelsAvailableMessage();
		expect(message).toMatch(/^No models available\. Use \/login to connect/);
		expect(message).toContain("providers.md");
		expect(formatNoApiKeyFoundMessage("openai")).toContain("Use /login to connect");
	});

	it("on the command line says how to reach /login and offers an environment variable", () => {
		const message = formatNoModelsAvailableMessage("cli");
		expect(message).toContain(`Run \`${APP_NAME}\` and use /login`);
		expect(message).toContain("API key environment variable");
		expect(message).not.toMatch(/\. Use \/login/);
		expect(message).toContain("models.md");
	});
});
