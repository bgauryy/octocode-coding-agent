import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/features/index.ts";
import type { RunnerState } from "../src/octocode/external/runner-status.ts";

const runners = vi.hoisted(() => ({ list: vi.fn(() => []) }));
vi.mock("../src/octocode/external/runner-status.ts", () => ({
	listRunners: runners.list,
	checkRunners: vi.fn(async () => []),
	cachedRunners: () => [],
	forgetRunner: vi.fn(),
	isConnected: (state: RunnerState) => state.cli && state.adapter && state.auth?.signedIn === true,
}));
vi.mock("../../common/src/find-on-path.ts", () => ({ findOnPath: () => "/fixture/vendor-cli" }));

import { listedRunners, runnerSection } from "../src/modes/interactive/interactive-mode/provider-runners.ts";
import { runnerRows } from "../src/octocode/external/connected.ts";
import { launchOf } from "../src/octocode/external/runner-session.ts";
import { runnerSpec } from "../src/octocode/external/runners.ts";
import { runRunnerChild } from "../src/octocode/subagents/runner-child.ts";

const state: RunnerState = {
	id: "gemini",
	name: "Gemini CLI",
	cli: true,
	adapter: true,
	checkedAt: 1,
	auth: { signedIn: true },
};
const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external runner facts", () => {
	it("uses an explicit page home even when no environment was supplied", () => {
		listedRunners({ home: "/fixture/home", agentDir: "/fixture/agent" }, vi.fn());
		expect(runners.list).toHaveBeenCalledWith(
			expect.objectContaining({ HOME: "/fixture/home", USERPROFILE: "/fixture/home", PATH: process.env.PATH }),
			"/fixture/agent",
		);
	});

	it("shows unknown billing for a sign-in probe that did not establish a plan", () => {
		expect(runnerSection([state], true).rows[0].detail).toContain("billing unknown");
		expect(runnerRows([state]).join("\n")).toContain("billing unknown");
		expect(launchOf(state.id, [state]).billing).toBeUndefined();
	});

	it.each([undefined, "future-login"])(
		"does not infer a Claude plan from an unknown login method (%s)",
		(authMethod) => {
			expect(
				runnerSpec("claude-code")!.status!.read(JSON.stringify({ loggedIn: true, authMethod }), 0)?.billing,
			).toBeUndefined();
		},
	);

	it.each(["bedrock", "vertex"])("retains explicit %s metered billing without a login method", (apiProvider) => {
		expect(runnerSpec("claude-code")!.status!.read(JSON.stringify({ loggedIn: true, apiProvider }), 0)?.billing).toBe(
			"metered",
		);
	});

	it.each(["plan", "metered"] as const)("retains explicit %s billing in the UI and launch", (billing) => {
		const known = { ...state, auth: { signedIn: true, billing } };
		expect(runnerSection([known], true).rows[0].detail).toContain(billing === "plan" ? "plan" : "metered key");
		expect(runnerRows([known]).join("\n")).toContain(billing === "plan" ? "plan" : "metered key");
		expect(launchOf(known.id, [known]).billing).toBe(billing);
	});

	it.each([
		{ billing: undefined, cost: 0.75 },
		{ billing: "metered" as const, cost: 0.75 },
		{ billing: "plan" as const, cost: 0 },
	])("keeps reported dollars unless a plan is established ($billing)", async ({ billing, cost }) => {
		const root = mkdtempSync(join(tmpdir(), "octocode-runner-billing-"));
		roots.push(root);
		const result = await runRunnerChild(
			{ ids: [state.id], turn: async () => ({ text: "done: completed task", cost: 0.75, billing }) },
			{
				runner: state.id,
				task: "inspect the fixture",
				cwd: root,
				identity: { id: "billing-fixture", scratch: root },
				signal: undefined,
				onProgress: vi.fn(),
				ctx: { cwd: root } as ExtensionContext,
			},
		);
		expect(result.billing).toBe(billing);
		expect(result.usage.cost.total).toBe(cost);
	});
});
