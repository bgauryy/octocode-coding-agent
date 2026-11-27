import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../../../src/octocode/api/events.ts";
import { apiDir, ensurePrivateDir, instancesDir, socketPath } from "../../../src/octocode/api/registry.ts";
import { ApiServer } from "../../../src/octocode/api/server.ts";

/**
 * Another Octocode process as its session API shows it, for multi-process tests: it publishes `instances/<id>.json`
 * under `OCTOCODE_HOME` and answers `message.send` and `status`. `mode` says what a send does: `turn` (the message
 * starts a turn), `queue` (it waits in the queue and stays unread) or `queue-read` (it is queued, and `status` reports
 * the queue read). Each message it takes is printed as `received <json>`; `ready <socket>` once it listens.
 */
const [id, name, cwd, mode] = process.argv.slice(2) as [string, string, string, "turn" | "queue" | "queue-read"];
ensurePrivateDir(apiDir());
const socket = socketPath(apiDir(), id);
let next = 0;
const server = new ApiServer(
	async (method, params) => {
		if (method === "status") return { state: "working", pending: mode === "queue" };
		if (method !== "message.send") throw new Error(`unexpected ${method}`);
		process.stdout.write(`received ${JSON.stringify({ text: params.text, from: params.from })}\n`);
		return { id: `m${++next}`, queued: mode === "turn" ? "turn" : "steer" };
	},
	new EventLog(),
	"token",
);
await server.listenUnix(socket);
writeFileSync(
	join(instancesDir(apiDir()), `${id}.json`),
	JSON.stringify({ id, pid: process.pid, cwd, startedAt: Date.now(), protocol: 1, name, socket }),
);
process.stdout.write(`ready ${socket}\n`);
const stop = (): void => void server.close().finally(() => process.exit(0));
process.once("SIGTERM", stop);
// The API server does not hold the process open; this check does, until the test kills it. A test process that died
// without killing this one leaves no orphan behind.
const parent = process.ppid;
setInterval(() => {
	if (process.ppid !== parent) stop();
}, 1_000);
