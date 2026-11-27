import { processStartTime } from "../../../src/octocode/shared/process.ts";
import { namedParent } from "../../../src/octocode/team/session/parent.ts";
import { AGENT_GOAL_ENV, AGENT_ID_ENV } from "../../../src/octocode/team/store/env.ts";
import { TeamStore } from "../../../src/octocode/team/store.ts";

/**
 * A subagent's process joining under the name its parent chose, with the parent named in the environment as
 * `subagentProcessEnv` names it: prints `joined <pid>` or `refused`, and stays running until its stdin ends.
 */
const [cwd, db] = process.argv.slice(2) as [string, string];
const store = TeamStore.open(cwd, db);
const started = processStartTime(process.pid);
const joined = store.join(
	{
		id: process.env[AGENT_ID_ENV]!,
		role: "worker",
		pid: process.pid,
		...(started ? { started } : {}),
		status: "working",
		goal: process.env[AGENT_GOAL_ENV]!,
		joinedAt: Date.now(),
		updatedAt: Date.now(),
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	},
	namedParent(process.env),
);
process.stdout.write(joined ? `joined ${process.pid}\n` : "refused\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
