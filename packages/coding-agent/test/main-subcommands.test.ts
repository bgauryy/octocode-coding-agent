import { afterEach, describe, expect, it, vi } from "vitest";

const packageCli = vi.hoisted(() => ({
	handlePackageCommand: vi.fn(async () => false),
	handleConfigCommand: vi.fn(async () => false),
}));
vi.mock("../src/package-manager-cli.ts", () => packageCli);
const trust = vi.hoisted(() => ({ runTrustCommand: vi.fn(async () => 3) }));
vi.mock("../src/cli/trust-command.ts", () => trust);

import { runSubcommand, SUBCOMMANDS } from "../src/main/subcommands.ts";

afterEach(() => {
	process.exitCode = undefined;
});

describe("one-shot subcommands", () => {
	it("are one table of names, each loaded on use", () => {
		expect(Object.keys(SUBCOMMANDS).sort()).toEqual([
			"backlog",
			"context",
			"marketplace",
			"mcp",
			"plugin",
			"profile",
			"security",
			"trust",
		]);
	});

	it("run the named command with the arguments after its name and keep its exit code", async () => {
		await expect(runSubcommand(["trust", "--list"], { cwd: "/work", agentDir: "/agent" })).resolves.toBe(true);
		expect(trust.runTrustCommand).toHaveBeenCalledExactlyOnceWith(["--list"], { cwd: "/work" });
		expect(process.exitCode).toBe(3);
	});

	it("leave anything else, including inherited object keys, to a session run", async () => {
		for (const args of [[], ["fix the bug"], ["toString"], ["--print", "hi"]])
			await expect(runSubcommand(args, { cwd: "/work", agentDir: "/agent" })).resolves.toBe(false);
		expect(process.exitCode).toBeUndefined();
	});
});
