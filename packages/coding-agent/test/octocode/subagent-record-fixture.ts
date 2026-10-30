import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

export function setup(cwd = tmp("octocode-agent-cwd-")) {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, () => new Map(), team, fakePermission());
	const commands = new Subcommands();
	commands.add("agents", control.command);
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getCachePolicy: (_model: unknown, settings: readonly CachePreferenceLayer[] = []) =>
				mergeCachePreferences(settings),
		},
	});
	team.start(ctx);
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>, onUpdate?: (update: unknown) => void) =>
		agent.execute("call-1", { goal: "check things", ...params }, undefined, onUpdate, ctx);
	return { ...f, team, ctx, agent, run, control };
}
