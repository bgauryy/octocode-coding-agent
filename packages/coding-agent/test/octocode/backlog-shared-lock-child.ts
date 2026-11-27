import { acquireRegistryLock } from "../../src/octocode/backlog/shared-web-lock.ts";

const lockPath = process.env.SHARED_LOCK_PATH;
if (!lockPath) {
	process.stderr.write("SHARED_LOCK_PATH is required\n");
	process.exit(1);
}

// Holds the registry lock until it is killed, as a launcher that crashed inside the startup window.
await acquireRegistryLock(lockPath);
if (process.send) process.send("locked");
setInterval(() => undefined, 1000);
