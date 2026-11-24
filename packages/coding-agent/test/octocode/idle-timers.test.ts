import { afterEach, expect, it, vi } from "vitest";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeHost, fakePermission } from "./fake-host.ts";

afterEach(() => vi.useRealTimers());

it("an idle session with the team and the agent tool registered holds no timer", async () => {
	vi.useFakeTimers();
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, {
		profiles: () => new Map(),
		team,
		permission: fakePermission(),
		limits: { maxSubagents: 2, lingerSeconds: 0 },
	});
	new Subcommands().add("agents", control.command);
	await vi.advanceTimersByTimeAsync(5000);
	expect(vi.getTimerCount()).toBe(0);
	await team.stop();
	expect(vi.getTimerCount()).toBe(0);
});
