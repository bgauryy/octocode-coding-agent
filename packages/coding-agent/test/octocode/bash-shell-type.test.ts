import { describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const DECLARED = ["bash", "file", "mcp__octocode__localSearch"];

function bashTool() {
	const { api, tools } = fakeHost();
	Object.assign(api.tools, { getAll: () => DECLARED.map((name) => ({ name })) });
	registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
	return tools.get("bash") as { prepareArguments: (args: unknown) => unknown };
}

describe("bash: `type` names a declared tool", () => {
	it.each(["file", "mcp__octocode__localSearch"])("refuses type %s and says to call that tool directly", (name) => {
		const tool = bashTool();
		expect(() => tool.prepareArguments({ type: name, command: "ls" })).toThrow(
			new RegExp(`\`type\` selects the shell.*"${name}" is a tool.*Call the "${name}" tool directly`),
		);
	});

	it("passes the shell names and calls without a type through unchanged", () => {
		const tool = bashTool();
		for (const args of [
			{ type: "bash", command: "ls" },
			{ type: "powershell", command: "Get-ChildItem" },
			{ command: "ls" },
		]) {
			expect(tool.prepareArguments(args)).toBe(args);
		}
	});

	it("leaves an unknown type to the schema check instead of naming a tool", () => {
		const tool = bashTool();
		expect(tool.prepareArguments({ type: "zsh", command: "ls" })).toEqual({ type: "zsh", command: "ls" });
	});
});

describe("bash: Claude Code's Bash field names", () => {
	it("runs `run_in_background` in the background and takes `description` as the reason", () => {
		const tool = bashTool();
		expect(
			tool.prepareArguments({ command: "yarn test", run_in_background: true, description: "Run the tests" }),
		).toEqual({ command: "yarn test", background: true, reason: "Run the tests" });
	});

	it("keeps our own fields when a call sends both", () => {
		const tool = bashTool();
		expect(
			tool.prepareArguments({
				command: "ls",
				background: false,
				run_in_background: true,
				reason: "mine",
				description: "x",
			}),
		).toEqual({ command: "ls", background: false, reason: "mine" });
	});
});
