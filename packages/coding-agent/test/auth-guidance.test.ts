import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import {
	formatAuthExpiredMessage,
	formatAuthRefreshFailedMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
	setAuthGuidanceSurface,
} from "../src/core/auth-guidance.ts";

describe("auth guidance", () => {
	it("inside a session leads with the action and keeps the docs on one line", () => {
		const message = formatNoModelsAvailableMessage();
		expect(message).toMatch(/^No AI provider connected yet\. Type \/providers to connect one/);
		expect(message).toMatch(/\nDocs: providers\.md · models\.md in /);
		expect(formatNoApiKeyFoundMessage("openai")).toMatch(/^No usable credentials for openai\. Type \/providers/);
		expect(formatNoModelSelectedMessage()).toContain("Then /model to pick a model.");
	});

	it("on the command line says how to reach /providers and offers an environment variable", () => {
		const message = formatNoModelsAvailableMessage("cli");
		expect(message).toContain(`Run \`${APP_NAME}\` and type /providers`);
		expect(message).toContain("API key environment variable");
		expect(message).toContain("models.md");
	});

	it("on the command line never asks to type a slash command", () => {
		const run = `Run \`${APP_NAME}\` and type /providers`;
		const messages = [
			formatNoModelSelectedMessage("cli"),
			formatNoApiKeyFoundMessage("openai", "cli"),
			formatAuthRefreshFailedMessage("openai", "invalid_grant", "cli"),
			formatAuthExpiredMessage("openai", "cli"),
		];
		for (const message of messages) expect(message).not.toMatch(/(?:^|\. )Type \/providers|then \/model/);
		expect(messages[0]).toContain(`${run} to connect one`);
		expect(messages[0]).toContain("--model <provider>/<id>");
		expect(messages[1]).toMatch(/^No usable credentials for openai\. Set its API key environment variable/);
		expect(messages[1]).toContain(`${APP_NAME} auth check --provider openai`);
		expect(messages[2]).toBe(
			`Sign-in for openai could not be renewed. ${run} openai to sign in again. (invalid_grant)`,
		);
		expect(messages[3]).toContain(`${run} openai to sign in again.`);
	});

	it("follows the surface a headless run sets for the process", () => {
		setAuthGuidanceSurface("cli");
		try {
			expect(formatNoApiKeyFoundMessage("openai")).toBe(formatNoApiKeyFoundMessage("openai", "cli"));
		} finally {
			setAuthGuidanceSurface("session");
		}
		expect(formatNoApiKeyFoundMessage("openai")).toMatch(/Type \/providers/);
	});

	it("tells a sign-in that could not be renewed how to sign in again and keeps the reason", () => {
		expect(formatAuthRefreshFailedMessage("openai", "OAuth refresh failed for openai: (400 invalid_grant)")).toBe(
			"Sign-in for openai could not be renewed. Type /providers openai to sign in again. (OAuth refresh failed for openai: (400 invalid_grant))",
		);
	});

	it("tells an expired sign-in what to do", () => {
		expect(formatAuthExpiredMessage("anthropic")).toBe(
			"Sign-in for anthropic failed: the credentials may have expired, or the network is down. Type /providers anthropic to sign in again.",
		);
	});
});
