import { describe, expect, it } from "vitest";
import { hostQuirkHint } from "../../src/octocode/files/bash/host-hints.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NO_TIMEOUT = /no GNU `timeout`.*`timeout` parameter/;
const SED_SUFFIX = /needs a suffix after -i: use `sed -i ''`.*`file` tool/;

interface BashResult {
	content: { text: string }[];
	details: { exitCode: number; notices?: string[] };
}

describe("bash: macOS host quirks", () => {
	function runner() {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
		const cwd = tmp();
		return (command: string) =>
			tools
				.get("bash")
				.execute(
					"t",
					{ command, timeout: 4000, background: false },
					undefined,
					undefined,
					fakeCtx({ cwd }),
				) as Promise<BashResult>;
	}

	it.each([
		["bash timeout", "", "/bin/bash: timeout: command not found", 127, NO_TIMEOUT],
		["zsh timeout", "", "zsh:1: command not found: timeout", 127, NO_TIMEOUT],
		// The command names `sed -i` behind `true ||`, so it never runs, and BSD sed's stderr is echoed the same on every host.
		["BSD sed -i", "true || sed -i 's/a/b/' f; ", 'sed: 1: "s/a/b/": invalid command code s', 1, SED_SUFFIX],
		[
			"BSD sed -i label",
			"true || sed -E -i 's/a/b/' x.txt; ",
			"sed: 1: \"x.txt\": undefined label 'x.txt'",
			1,
			SED_SUFFIX,
		],
	])("names the alternative in the failed result for %s", async (_name, prefix, stderr, code, hint) => {
		const failed = await runner()(`${prefix}echo '${stderr}' >&2; exit ${code}`);
		expect(failed.details.exitCode).toBe(code);
		expect(failed.content[0].text).toMatch(hint);
		expect(failed.details.notices?.join("\n")).toMatch(hint);
	});

	it("adds no hint to other failures, to the same words inside other output, or to a success", async () => {
		const run = runner();
		for (const command of [
			"echo 'sed: usage error' >&2; exit 1",
			"echo 'grep hit: /bin/bash: timeout: command not found' >&2; exit 1",
			"echo 'timeout: command not found'; exit 0",
			// A BSD sed error from a command that never used `-i`: the suffix advice would be wrong.
			"true || sed 's/a/b' f; echo 'sed: 1: \"s/a/b\": invalid command code s' >&2; exit 1",
		]) {
			const result = await run(command);
			expect(result.content[0].text).not.toMatch(/macOS/);
		}
	});
});

describe("bash: repository layout hint", () => {
	const VITEST_ROOT = /packages\/coding-agent.*vitest\.octocode\.config\.ts/;
	const rootFailure = "Cannot resolve entry module vitest.octocode.config.ts";

	it.each(["darwin", "linux", "win32"] as const)("names packages/coding-agent on %s", (platform) => {
		expect(hostQuirkHint(rootFailure, "yarn vitest run --config vitest.octocode.config.ts", platform)).toMatch(
			VITEST_ROOT,
		);
	});

	it("gives the hint in the failed result of a root-level run", async () => {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
		const failed = (await tools.get("bash").execute(
			"t",
			{
				command: "echo 'Cannot resolve entry module vitest.octocode.config.ts' >&2; exit 1",
				timeout: 4000,
				background: false,
			},
			undefined,
			undefined,
			fakeCtx({ cwd: tmp() }),
		)) as { content: { text: string }[]; details: { notices?: string[] } };
		expect(failed.details.notices?.join("\n")).toMatch(VITEST_ROOT);
		expect(failed.content[0].text).toMatch(VITEST_ROOT);
	});
});

describe("host quirk hints by platform", () => {
	const timeoutFailure = "/bin/bash: timeout: command not found";
	it("gives the macOS hints on darwin only", () => {
		expect(hostQuirkHint(timeoutFailure, "timeout 5 ls", "darwin")).toMatch(NO_TIMEOUT);
		for (const platform of ["linux", "win32", "freebsd"] as const) {
			expect(hostQuirkHint(timeoutFailure, "timeout 5 ls", platform)).toBeUndefined();
			expect(hostQuirkHint('sed: 1: "s/a/b/": invalid command code s', "sed -i 's/a/b/' f", platform)).toBeUndefined();
		}
	});
});
