import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerEntry } from "../src/config.ts";
import { hostIdentity, installMcpHost } from "../src/host.ts";
import {
	installMcpServer,
	mcpInstallDir,
	type McpNpmRunner,
	resetMcpInstallFailures,
	resolveInstalledLaunch,
} from "../src/install.ts";
import { recommendedPresets } from "../src/recommended/index.ts";
import { validateMcpServerConfig } from "../src/servers.ts";
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

describe("install.hostDependency", () => {
	/** A host package folder that depends on `@scope/server` and has it installed (optionally without its build). */
	function hostPackage(options: { listed?: boolean; built?: boolean; exports?: unknown } = {}): string {
		const { listed = true, built = true } = options;
		const host = path.join(agentDir, "host");
		const dependency = path.join(host, "node_modules", "@scope", "server");
		fs.mkdirSync(path.join(dependency, "dist"), { recursive: true });
		const dependencies = listed ? { "@scope/server": "link:../server" } : {};
		fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "host", dependencies }));
		const exports = options.exports === undefined ? {} : { exports: options.exports };
		const manifest = { name: "@scope/server", version: "9.9.9", bin: { server: "dist/cli.js" }, ...exports };
		fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify(manifest));
		if (built) fs.writeFileSync(path.join(dependency, "dist", "cli.js"), "");
		return fs.realpathSync(host);
	}
	const entry = (hostDependency = true): McpServerEntry => ({
		name: "research",
		config: { command: "server", args: ["--flag"], install: { ...spec, hostDependency } },
		source: "test",
	});
	const launchArgs = (launched: McpServerEntry) => (launched.config as { args: string[] }).args;

	it("runs the host's own build of the package, whatever its version, without npm", async () => {
		const packageDir = hostPackage();
		const npm = fakeNpm();
		const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir, runNpm: npm });
		expect((launched.config as { command: string }).command).toBe(process.execPath);
		expect(launchArgs(launched)).toEqual([
			path.join(packageDir, "node_modules", "@scope", "server", "dist", "cli.js"),
			"--flag",
		]);
		expect(npm.calls).toEqual([]);
		expect(takeLaunchWarnings()).toEqual([]);
	});

	it("runs the package under node, not the host's own binary, from a compiled standalone agent", async () => {
		const packageDir = hostPackage();
		const identity = hostIdentity();
		installMcpHost({ identity: { ...identity, isBunBinary: () => true } });
		try {
			const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir, runNpm: fakeNpm() });
			expect((launched.config as { command: string }).command).toBe("node");
		} finally {
			installMcpHost({ identity });
		}
	});

	// `{ import }` is octocode-mcp's published shape: a `require` lookup of it fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
	it.each([
		["hide its package.json", { ".": "./dist/cli.js" }],
		["expose only an import entry", { ".": { import: "./dist/cli.js" } }],
		["are invalid", { ".": "./dist/cli.js", "./x": "./x.js", y: "./y.js" }],
	])("finds a package whose exports %s, without npm", async (_, exports) => {
		const packageDir = hostPackage({ exports });
		const npm = fakeNpm();
		const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir, runNpm: npm });
		expect(launchArgs(launched)[0]).toBe(path.join(packageDir, "node_modules", "@scope", "server", "dist", "cli.js"));
		expect(npm.calls).toEqual([]);
	});

	it("finds the package in a node_modules above the host, through a link", async () => {
		const real = path.join(agentDir, "server");
		fs.mkdirSync(path.join(real, "dist"), { recursive: true });
		fs.writeFileSync(path.join(real, "dist", "cli.js"), "");
		const manifest = { name: "@scope/server", bin: { server: "dist/cli.js" }, exports: { ".": { import: "./x.js" } } };
		fs.writeFileSync(path.join(real, "package.json"), JSON.stringify(manifest));
		fs.mkdirSync(path.join(agentDir, "node_modules", "@scope"), { recursive: true });
		fs.symlinkSync(real, path.join(agentDir, "node_modules", "@scope", "server"), "junction");
		const packageDir = path.join(agentDir, "packages", "host");
		fs.mkdirSync(packageDir, { recursive: true });
		const dependencies = { "@scope/server": "link:../../server" };
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "host", dependencies }));
		const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir, runNpm: fakeNpm() });
		expect(launchArgs(launched)[0]).toBe(path.join(fs.realpathSync(real), "dist", "cli.js"));
	});

	it.each([
		["", undefined],
		[" (import-only exports)", { ".": { import: "./dist/cli.js" } }],
	])("warns with the build command when the bin file is missing%s, then installs from npm", async (_, exports) => {
		const packageDir = hostPackage({ built: false, exports });
		const npm = fakeNpm();
		const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir, runNpm: npm });
		const [warning, ...rest] = takeLaunchWarnings();
		expect(rest).toEqual([]);
		expect(warning).toMatch(/MCP server "research": @scope\/server at .* is not built .*cli\.js is missing/);
		expect(warning).toContain("`yarn build`");
		expect(warning).toContain("Installing @scope/server@1.2.3 from npm instead");
		expect(npm.calls).toHaveLength(1);
		expect(launchArgs(launched)[0]).toContain(mcpInstallDir(agentDir, "research"));
	});

	it("installs when the host does not list the package, or the entry does not ask for it", async () => {
		const unlisted = hostPackage({ listed: false });
		const npm = fakeNpm();
		const launched = await resolveInstalledLaunch(entry(), { agentDir, packageDir: unlisted, runNpm: npm });
		expect(launchArgs(launched)[0]).toContain(mcpInstallDir(agentDir, "research"));
		const listed = hostPackage();
		const plain = await resolveInstalledLaunch(entry(false), { agentDir, packageDir: listed, runNpm: npm });
		expect(launchArgs(plain)[0]).toContain(mcpInstallDir(agentDir, "research"));
		expect(takeLaunchWarnings()).toEqual([]);
	});

	it("rejects a non-boolean hostDependency", () => {
		expect(validateMcpServerConfig("x", { command: "x", install: { ...spec, hostDependency: "yes" } })).toBe(
			'server "x": install.hostDependency must be a boolean',
		);
	});

	it("launches the default octocode entry from the octocode-mcp this checkout's coding-agent depends on", async () => {
		const octocode = recommendedPresets({}).find((preset) => preset.name === "octocode")!;
		const packageDir = path.resolve(import.meta.dirname, "../../coding-agent");
		const launched = await resolveInstalledLaunch(
			{ name: "octocode", config: octocode.config!, source: "built-in octocode" },
			{ agentDir, packageDir, runNpm: async () => expect.unreachable("npm must not run") },
		);
		const [bin] = launchArgs(launched);
		expect(bin).toMatch(/octocode-mcp[\\/]dist[\\/]index\.js$/);
		expect(fs.existsSync(bin)).toBe(true);
	});
});
