import { daemonPage } from "../../src/octocode/web-daemon/build.ts";
import { runWebDaemon } from "../../src/octocode/web-daemon/main.ts";

// A daemon of another build (`OCTOCODE_TEST_DAEMON_BUILD`, else an old version), for the drain tests.
await runWebDaemon(process.env, {
	page: { ...daemonPage(), build: process.env.OCTOCODE_TEST_DAEMON_BUILD ?? "0.0.0:old" },
});
