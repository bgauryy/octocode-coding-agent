import { beforeAll, describe, expect, it } from "vitest";
import { resolveToolConcurrency, ToolSchedule } from "../../../agent/src/agent-loop/tool-schedule.ts";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { bashConcurrency } from "../../src/octocode/files/bash/mutation.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** RFC 2026-11-11 core tools, step B5: a mutating bash command runs alone in its message; reads stay concurrent. */
beforeAll(() => shellParserReady());

describe("how a bash call is ordered in its message", () => {
	it.each([
		"git add x",
		"git commit -m y",
		"echo a > out.txt",
		"rm -rf build",
		"sed -i s/a/b/ file.ts",
		"npm install",
		"touch /tmp/marker",
		'echo x > "$F"',
	])("runs %j alone", (command) => {
		expect(bashConcurrency({ command })).toBe("exclusive");
	});

	it.each(["rg -n foo src", "git status", "git log --oneline -n 5", "ls -la", "cat a.ts | wc -l", "git diff"])(
		"runs %j alongside other calls",
		(command) => {
			expect(bashConcurrency({ command })).toBe("shared");
		},
	);

	it("reads a PowerShell command by its own classifier: only one it knows as a read runs alongside", () => {
		expect(bashConcurrency({ type: "powershell", command: "ls" })).toBe("shared");
		expect(bashConcurrency({ type: "powershell", command: "Remove-Item x" })).toBe("exclusive");
	});

	it("is what the registered tool declares", () => {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
		const tool = tools.get("bash");
		expect(resolveToolConcurrency(tool, { command: "git commit -m y" })).toBe("exclusive");
		expect(resolveToolConcurrency(tool, { command: "git status" })).toBe("shared");
	});
});

describe.runIf(process.platform !== "win32")("two bash calls of one message (V9)", () => {
	const run = async (commands: string[]) => {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({ backgroundAfterSeconds: 0 }));
		const tool = tools.get("bash");
		const ctx = fakeCtx({ cwd: tmp() });
		const schedule = new ToolSchedule();
		const spans: Array<{ command: string; start: number; end: number }> = [];
		await Promise.all(
			commands.map((command, index) =>
				schedule.add(resolveToolConcurrency(tool, { command }), async () => {
					const start = Date.now();
					await tool.execute(`t${index}`, { command }, undefined, undefined, ctx);
					spans.push({ command, start, end: Date.now() });
				}),
			),
		);
		return spans.sort((a, b) => a.start - b.start);
	};

	it("starts the second mutating command after the first one ended", async () => {
		const [first, second] = await run(["sleep 0.4; echo a > one.txt", "echo b > two.txt"]);
		expect(first.command).toContain("one.txt");
		expect(second.start).toBeGreaterThanOrEqual(first.end);
	});

	it("runs two read-only commands at the same time", async () => {
		const [first, second] = await run(["sleep 0.4; ls", "sleep 0.4; ls -la"]);
		expect(second.start).toBeLessThan(first.end);
	});
});
