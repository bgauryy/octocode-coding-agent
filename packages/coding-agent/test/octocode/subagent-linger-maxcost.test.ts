/** A message to a lingering child resumes it as a `resume` task would: past `subagents.maxCost` it is refused (O6). */
import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

beforeAll(() => {
	const root = tmp("octocode-agent-linger-maxcost-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

it("refuses a message to a lingering child once the session spent past subagents.maxCost", async () => {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission("full") });
	const ctx = fakeCtx({ cwd: tmp() });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [],
			find: () => undefined,
			getCachePolicy: (_model: unknown, settings: readonly CachePreferenceLayer[] = []) =>
				mergeCachePreferences(settings),
		},
	});
	team.start(ctx);
	try {
		// The fixture child reports `blocked`, so it lingers for an answer.
		const { details } = await f.tools
			.get("agent")
			.execute(
				"c1",
				{ task: "linger blocked on a decision", goal: "linger test", background: true },
				undefined,
				undefined,
				ctx,
			);
		await control.settle();
		// The session has now spent $0.75 against a $0.50 cap.
		const settings = f.api.settings.get();
		vi.spyOn(f.api.settings, "get").mockReturnValue({ ...settings, subagents: { maxCost: 0.5 } });
		ctx.sessionManager.getEntries = () =>
			[
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "faux",
						model: "model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } },
					},
				},
			] as never;
		// A new task is refused…
		await expect(
			f.tools.get("agent").execute("c2", { task: "report", goal: "g2" }, undefined, undefined, ctx),
		).rejects.toThrow(/maxCost/);
		// …and so is the message that would resume the lingering child.
		await expect(team.send(details.id, "linger answered: go on", { replyRequired: false })).rejects.toThrow(
			/spent \$0\.75, and subagents\.maxCost is \$0\.50/,
		);
	} finally {
		await control.stopAll();
		team.stop();
	}
});
