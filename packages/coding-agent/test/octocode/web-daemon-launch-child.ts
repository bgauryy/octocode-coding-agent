import { ensureWebDaemon } from "../../src/octocode/web-daemon/launcher.ts";

// A "session" that launches the daemon and then goes away.
const entry = process.argv[2];
const resolver = process.argv[3];
const daemon = await ensureWebDaemon({
	invocation: { command: process.execPath, prefix: ["--import", resolver, entry] },
});
console.log(JSON.stringify({ pid: daemon.record.pid, origin: daemon.origin }));
process.exit(0);
