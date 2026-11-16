// A stand-in for an Octocode process: starts a server group, records it, reports the group pid, then idles.
import { spawn } from "node:child_process";
import { recordProcessGroup } from "../../../../common/src/process-group-records.ts";

const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
await recordProcessGroup(process.argv[2], child.pid, "fake server");
process.stdout.write(`${child.pid}\n`);
setInterval(() => {}, 1000);
