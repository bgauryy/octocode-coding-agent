import { describe, expect, it } from "vitest";
import { providersSharingApiKeyEnvVar } from "../src/auth/api-key-env-vars.ts";

describe("providers sharing one API-key environment variable", () => {
	it.each([
		["MOONSHOT_API_KEY", "moonshotai", ["moonshotai-cn"]],
		["MOONSHOT_API_KEY", "moonshotai-cn", ["moonshotai"]],
		["CLOUDFLARE_API_KEY", "cloudflare-workers-ai", ["cloudflare-ai-gateway"]],
		["OPENCODE_API_KEY", "opencode", ["opencode-go"]],
		["QWEN_TOKEN_PLAN_API_KEY", "qwen-token-plan", ["qwen-token-plan-individual"]],
	])("%s of %s is also read by %j", (envVar, provider, others) => {
		expect(providersSharingApiKeyEnvVar(envVar, provider)).toEqual(others);
	});

	it("is empty for a variable only one provider reads", () => {
		expect(providersSharingApiKeyEnvVar("DEEPSEEK_API_KEY", "deepseek")).toEqual([]);
	});
});
