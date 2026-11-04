import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerEntry } from "../src/config.ts";
import {
	installMcpServer,
	mcpInstallDir,
	type McpNpmRunner,
	resetMcpInstallFailures,
	resolveInstalledLaunch,
} from "../src/install.ts";
import { takeLaunchWarnings } from "../src/warnings.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-"));
	resetMcpInstallFailures();
	takeLaunchWarnings();
});
afterEach(() => fs.rmSync(agentDir, { recursive: true, force: true }));

/** A fake npm that writes the package as `npm install --prefix` would, and records each call. */
function fakeNpm(version = "1.2.3"): McpNpmRunner & { calls: string[][] } {
	const calls: string[][] = [];
	const run: McpNpmRunner = async (args) => {
		calls.push(args);
		const prefix = args[args.indexOf("--prefix") + 1];
		const dir = path.join(prefix, "node_modules", "@scope", "server");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version, bin: { server: "dist/cli.js" } }));
	};
	return Object.assign(run, { calls });
}

const spec = { npm: "@scope/server", version: "1.2.3" };

describe("installMcpServer", () => {
	it("installs once with --ignore-scripts into the agent folder and resolves the bin", async () => {
		const npm = fakeNpm();
		const bin = await installMcpServer("research", spec, { agentDir, runNpm: npm });
		const dir = mcpInstallDir(agentDir, "research");
		expect(dir).toBe(path.join(agentDir, "mcp", "servers", "research"));
		expect(bin).toBe(path.join(dir, "node_modules", "@scope", "server", "dist", "cli.js"));
		expect(npm.calls).toEqual([["install", "--prefix", dir, "--no-save", "--ignore-scripts", "@scope/server@1.2.3"]]);
		await installMcpServer("research", spec, { agentDir, runNpm: npm });
		expect(npm.calls).toHaveLength(1);
	});

	it("reinstalls when the installed version differs", async () => {
		await installMcpServer("research", { ...spec, version: "1.0.0" }, { agentDir, runNpm: fakeNpm("1.0.0") });
		const npm = fakeNpm();
		await installMcpServer("research", spec, { agentDir, runNpm: npm });
		expect(npm.calls).toHaveLength(1);
	});

	it("leaves the server out with one warning on failure, without retrying npm", async () => {
		let calls = 0;
		const failing: McpNpmRunner = async () => {
			calls++;
			throw new Error("spawn npm ENOENT");
		};
		await expect(installMcpServer("research", spec, { agentDir, runNpm: failing })).rejects.toThrow(
			/MCP server "research" is left out: installing @scope\/server@1\.2\.3 .* failed: spawn npm ENOENT/,
		);
		await expect(installMcpServer("research", spec, { agentDir, runNpm: failing })).rejects.toThrow(/left out/);
		expect(calls).toBe(1);
		expect(takeLaunchWarnings()).toHaveLength(1);
	});

	it("fails when npm succeeds without the version", async () => {
		await expect(installMcpServer("research", spec, { agentDir, runNpm: async () => {} })).rejects.toThrow(
			/does not hold version 1\.2\.3/,
		);
	});
});

describe("resolveInstalledLaunch", () => {
	it("runs the installed bin with node before the configured args, never npx", async () => {
		const entry: McpServerEntry = {
			name: "research",
			config: { command: "server", args: ["--flag"], install: spec },
			source: "test",
		};
		const launched = await resolveInstalledLaunch(entry, { agentDir, runNpm: fakeNpm() });
		const config = launched.config as { command: string; args: string[] };
		expect(config.command).toBe(process.execPath);
		expect(config.args[0]).toMatch(/dist[\\/]cli\.js$/);
		expect(config.args.slice(1)).toEqual(["--flag"]);
	});

	it("leaves an entry without install unchanged", async () => {
		const entry: McpServerEntry = { name: "plain", config: { command: "server" }, source: "test" };
		expect(await resolveInstalledLaunch(entry, { agentDir })).toBe(entry);
	});
});
