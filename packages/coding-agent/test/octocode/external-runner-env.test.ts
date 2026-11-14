import { describe, expect, it } from "vitest";
import { agentEnv } from "../../src/octocode/external/runner-env.ts";

describe("runner credential ownership", () => {
	it.each(["claude-code", "codex", "opencode", "gemini", "unknown-vendor"])(
		"isolates known credentials for %s",
		(vendor) => {
			const clean = agentEnv(vendor, {
				PATH: "/fixture/bin",
				HOME: "/fixture/home",
				CODEX_HOME: "/fixture/codex",
				CLAUDE_CONFIG_DIR: "/fixture/claude",
				GEMINI_CLI_HOME: "/fixture/gemini",
				CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-token",
				GEMINI_CLI_CUSTOM_HEADERS: "Authorization: Bearer fixture-gemini-token",
				GOOGLE_GEMINI_BASE_URL: "https://gateway.example/google",
				GOOGLE_GENAI_API_VERSION: "v1beta",
				ANTHROPIC_API_KEY: "fixture-api-key",
				ANTHROPIC_BASE_URL: "https://other.example",
				CODEX_API_KEY: "fixture-codex-key",
				OPENAI_API_KEY: "fixture-openai-key",
				GEMINI_API_KEY: "fixture-google-key",
				OCTOCODE_SUBAGENT: "1",
				OCTOCODE_HOME: "/fixture/octocode",
			});
			expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBe(vendor === "claude-code" ? "fixture-claude-token" : undefined);
			expect(clean.GEMINI_CLI_CUSTOM_HEADERS).toBe(
				vendor === "gemini" ? "Authorization: Bearer fixture-gemini-token" : undefined,
			);
			for (const key of [
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_BASE_URL",
				"CODEX_API_KEY",
				"OPENAI_API_KEY",
				"GEMINI_API_KEY",
				"OCTOCODE_SUBAGENT",
			])
				expect(clean).not.toHaveProperty(key);
			expect(clean).toMatchObject({
				PATH: "/fixture/bin",
				HOME: "/fixture/home",
				CODEX_HOME: "/fixture/codex",
				CLAUDE_CONFIG_DIR: "/fixture/claude",
				GEMINI_CLI_HOME: "/fixture/gemini",
				GOOGLE_GEMINI_BASE_URL: "https://gateway.example/google",
				GOOGLE_GENAI_API_VERSION: "v1beta",
				OCTOCODE_HOME: "/fixture/octocode",
			});
		},
	);
});
