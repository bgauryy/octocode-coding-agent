import { daemonPage } from "../../src/octocode/web-daemon/build.ts";
import { runWebDaemon } from "../../src/octocode/web-daemon/main.ts";

// A daemon of another build, for the drain test.
await runWebDaemon(process.env, { page: { ...daemonPage(), build: "0.0.0:old" } });
