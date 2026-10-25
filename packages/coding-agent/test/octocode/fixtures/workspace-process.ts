import { openAgentDb } from "../../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../../src/octocode/backlog/store.ts";
import { sharedWorkspaceWeb } from "../../../src/octocode/backlog/shared-web.ts";
import { startWorkspaceWeb } from "../../../src/octocode/workspace/server.ts";

const [repoRoot, file, session] = process.argv.slice(2);
if (!repoRoot || !file || !session) throw new Error("Expected repository, database and session");
const db = openAgentDb(file);
const store = new BacklogStore(() => db, "shared-repo");
const backlog = { store, actor: { id: session }, session, repoName: "Workspace test", repoRoot };
const open = sharedWorkspaceWeb(async (_ctx, current, changed) => startWorkspaceWeb(current, changed, {
	snapshot: () => ({ sessionId: session, agents: [], traffic: [], events: [], receipts: [] }),
	subscribe: () => () => {},
	close: () => {},
	execute: async (command) => ({
		id: command.id,
		action: command.action,
		status: "accepted",
		at: Date.now(),
		message: `Delivered to ${session}`,
	}),
}), { OCTOCODE_AGENT_DB: file });
const web = await open({} as never, backlog, () => {});
process.send?.({ url: web.url, session, pid: process.pid });

async function close() {
	await web.close();
	db.close();
	process.exit(0);
}
process.on("message", (message) => { if (message === "close") void close(); });
process.on("SIGTERM", () => void close());
process.on("disconnect", () => void close());
