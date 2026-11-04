import { processStartTime } from "../../src/octocode/shared/process.ts";
import { watchParentProcess } from "../../src/octocode/team/session/parent.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/**
 * A subagent process as the team sees it: joins as `id` under `parentId` with a registration (a session of its own), prints
 * `joined <id>` (a peer when no parent is named), and, like `Team.start`, watches the process `OCTOCODE_PARENT_PID` names: when it is gone the child leaves
 * with `parent-gone` and exits.
 */
const [cwd, db, id, parentId] = process.argv.slice(2) as [string, string, string, string | undefined];
const store = TeamStore.open(cwd, db);
store.lifecycle = { activationId: `activation-${id}`, sessionId: `session-${id}` };
const started = processStartTime(process.pid);
const member: Member = {
	id,
	role: "researcher",
	...(parentId ? { parentId } : {}),
	pid: process.pid,
	...(started ? { started } : {}),
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 3,
	input: 100,
	cacheRead: 10,
	output: 20,
	cost: 0.5,
	unpriced: false,
};
if (!store.join(member)) throw new Error(`The team name ${id} is taken.`);
watchParentProcess(process.env, () => {
	store.remove(id, Date.now(), member, "parent-gone");
	process.exit(0);
});
process.stdout.write(`joined ${id}\n`);
setInterval(() => undefined, 1000);
