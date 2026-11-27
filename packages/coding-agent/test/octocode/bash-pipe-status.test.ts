import { describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { pipeStatusNote } from "../../src/octocode/native/tools/bash/pipe-status.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

async function run(command: string) {
	const { api, tools } = fakeHost();
	const dir = tmp();
	registerBashTool(api, new Subcommands(), new BashJobs(dir), () => ({}));
	const result = await tools
		.get("bash")
		.execute("t", { command, timeout: 20, background: false }, undefined, undefined, fakeCtx({ cwd: dir }));
	return { text: String(result.content[0].text), exitCode: result.details?.exitCode as number | undefined };
}

describe("bash pipeline stage failures", () => {
	it("names a failing stage before the last and keeps the exit code", async () => {
		const { text, exitCode } = await run("(echo out; exit 2) | cat | cat");
		expect(text).toContain("stage 1 of 3 exited 2");
		expect(text).toContain("out");
		expect(exitCode).toBe(0);
	});

	it("reports nothing when a producer ends by SIGPIPE", async () => {
		const { text, exitCode } = await run("yes | head -1");
		expect(text).not.toContain("stage");
		expect(text).toContain("y");
		expect(exitCode).toBe(0);
	});

	it("leaves a single command unchanged", async () => {
		const { text, exitCode } = await run("echo plain");
		expect(text).not.toContain("stage");
		expect(exitCode).toBe(0);
	});

	it("keeps the exit code of an exit command in a command with a pipe", async () => {
		const { text, exitCode } = await run("echo a | cat\nexit 3");
		expect(exitCode).toBe(3);
		expect(text).not.toContain("stage");
	});

	it("keeps a failing last stage's code", async () => {
		const { exitCode } = await run("echo a | grep zzz");
		expect(exitCode).toBe(1);
	});

	it("parses statuses", () => {
		expect(pipeStatusNote("0 0")).toBeUndefined();
		expect(pipeStatusNote("141 0")).toBeUndefined();
		expect(pipeStatusNote("1 2 0")).toBe("stage 1 of 3 exited 1; stage 2 of 3 exited 2");
		expect(pipeStatusNote("5")).toBeUndefined();
	});
});
