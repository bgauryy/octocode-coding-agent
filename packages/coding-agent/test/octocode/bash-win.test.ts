import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const tree = {
	start: vi.fn(async () => true),
	assign: vi.fn(async (_pid: number) => true),
	owns: vi.fn(() => false),
	kill: vi.fn(async () => true),
};
vi.mock("../../src/utils/windows/winhelper.ts", () => ({
	windowsTree: {
		start: () => tree.start(),
		assign: (pid: number) => tree.assign(pid),
		owns: () => tree.owns(),
		kill: () => tree.kill(),
	},
}));

// The setup file already loaded these modules (through the MCP host ports); reload them under the mocks above.
vi.resetModules();
const { createLocalBashOperations } = await import("../../src/core/tools/bash/local-operations.ts");
const { registerBashTool } = await import("../../src/octocode/files/bash.ts");
const { BashJobs } = await import("../../src/octocode/files/bash-jobs.ts");
const { Subcommands } = await import("../../src/octocode/shared/commands.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.clearAllMocks();
});

/** The bash tool on a pretend Windows, with `/bin/sh` standing in for the shell (the spawn itself is real). */
const setup = () => {
	const { api, tools } = fakeHost();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), jobs, () => ({ shellPath: "/bin/sh" }));
	Object.defineProperty(process, "platform", { value: "win32" });
	return { tool: tools.get("bash"), jobs, ctx: fakeCtx({ cwd: tmp() }) };
};

describe("bash on Windows puts each spawned shell in a job", () => {
	it("prepares the helper before, and assigns the pid after, a foreground command spawns", async () => {
		const { tool, ctx } = setup();
		await tool.execute("t1", { command: "echo hi" }, undefined, undefined, ctx);
		expect(tree.start).toHaveBeenCalledTimes(1);
		expect(tree.assign).toHaveBeenCalledTimes(1);
		expect(tree.assign.mock.calls[0][0]).toBeGreaterThan(1);
		expect(tree.start.mock.invocationCallOrder[0]).toBeLessThan(tree.assign.mock.invocationCallOrder[0]);
	});

	it("does the same for a background job", async () => {
		const { tool, ctx, jobs } = setup();
		await tool.execute("t1", { command: "sleep 1", background: true }, undefined, undefined, ctx);
		expect(tree.start).toHaveBeenCalledTimes(1);
		expect(tree.assign).toHaveBeenCalledTimes(1);
		await jobs.stopAll("session end");
	});
});

describe("core's local bash puts its shell in a job too", () => {
	it("prepares the helper before, and assigns the pid after, the shell spawns", async () => {
		const operations = createLocalBashOperations({ shellPath: "/bin/sh" });
		Object.defineProperty(process, "platform", { value: "win32" });
		const chunks: Buffer[] = [];
		const { exitCode } = await operations.exec("echo hi", tmp(), { onData: (data) => chunks.push(data) });
		expect(exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("hi");
		expect(tree.start).toHaveBeenCalledTimes(1);
		expect(tree.assign).toHaveBeenCalledTimes(1);
		expect(tree.assign.mock.calls[0][0]).toBeGreaterThan(1);
		expect(tree.start.mock.invocationCallOrder[0]).toBeLessThan(tree.assign.mock.invocationCallOrder[0]);
	});
});
