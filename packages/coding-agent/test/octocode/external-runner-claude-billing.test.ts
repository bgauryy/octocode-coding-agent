import { describe, expect, it } from "vitest";
import { runnerSpec } from "../../src/octocode/external/runners.ts";
import { runRunnerChild } from "../../src/octocode/subagents/runner-child.ts";
import type { Runners } from "../../src/octocode/subagents/runner-port.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const read = (status: Record<string, unknown>) => runnerSpec("claude-code")!.status!.read(JSON.stringify(status), 0);

describe("Claude Code OAuth token billing", () => {
	it("recognizes the actual first-party access-token CLI status as plan billed", () => {
		expect(read({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" })).toEqual({
			signedIn: true,
			method: "oauth_token",
			billing: "plan",
		});
		expect(read({ loggedIn: false, authMethod: "oauth_token", apiProvider: "firstParty" })).toEqual({
			signedIn: false,
		});
	});
	it.each([
		[{ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, "metered"],
		[{ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }, "metered"],
		[{ loggedIn: true, authMethod: "oauth_token", apiProvider: "bedrock" }, "metered"],
		[{ loggedIn: true, authMethod: "oauth_token", apiProvider: "gateway" }, undefined],
		[{ loggedIn: true, authMethod: "unknown", apiProvider: "firstParty" }, undefined],
	])("preserves key/backend precedence and unknown billing for %j", (status, billing) => {
		expect(read(status)?.billing).toBe(billing);
	});
	it.each(["oauth_token", "api_key"])(
		"carries %s billing into child expenses without losing token usage",
		async (authMethod) => {
			const auth = read({ loggedIn: true, authMethod, apiProvider: "firstParty" })!;
			const cwd = tmp("octocode-claude-billing-");
			const runners: Runners = {
				ids: ["claude-code"],
				turn: async () => ({
					text: "done: verified arithmetic",
					billing: auth.billing,
					cost: 0.125,
					usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 20, totalTokens: 130 },
				}),
			};
			const outcome = await runRunnerChild(runners, {
				runner: "claude-code",
				task: "Check arithmetic",
				cwd,
				identity: { id: "billing-child", goal: "Check arithmetic", scratch: cwd },
				signal: undefined,
				onProgress: () => undefined,
				ctx: fakeCtx({ cwd }),
			});
			expect(outcome.billing).toBe(authMethod === "oauth_token" ? "plan" : "metered");
			expect(outcome.usage.cost.total).toBe(authMethod === "oauth_token" ? 0 : 0.125);
			expect(outcome.usage.totalTokens).toBe(130);
			expect(outcome.usage.cacheRead).toBe(20);
		},
	);
});
