import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitDependencyInstallArgs, getNpmInstallArgs } from "../src/core/package-manager/npm.ts";
import type { PackageManagerHost } from "../src/core/package-manager/types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const host = { settingsManager: { getNpmCommand: () => undefined } } as unknown as PackageManagerHost;
const npmAvailable = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;

/** A local package whose install script would write `marker` next to itself. */
function fixture(root: string): { pkg: string; marker: string } {
	const pkg = join(root, "scripted");
	mkdirSync(pkg);
	const marker = join(root, "postinstall-ran");
	writeFileSync(join(pkg, "mark.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "scripted", version: "1.0.0", scripts: { postinstall: "node mark.cjs" } }),
	);
	return { pkg, marker };
}

const env = (root: string) => ({
	...process.env,
	npm_config_cache: join(root, "cache"),
	npm_config_userconfig: join(root, "npmrc"),
	npm_config_offline: "true",
	npm_config_audit: "false",
	npm_config_fund: "false",
});

describe("package installs run no lifecycle scripts", () => {
	it("passes --ignore-scripts for every package manager", () => {
		for (const command of [undefined, ["pnpm"], ["bun"]]) {
			const manager = { settingsManager: { getNpmCommand: () => command } } as unknown as PackageManagerHost;
			expect(getNpmInstallArgs(manager, ["x"], "/r")).toContain("--ignore-scripts");
			expect(getGitDependencyInstallArgs(manager)).toContain("--ignore-scripts");
		}
	});

	it.skipIf(!npmAvailable)("installs a package without running its postinstall", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-ignore-scripts-"));
		dirs.push(root);
		const { pkg, marker } = fixture(root);
		const prefix = join(root, "prefix");
		const run = spawnSync("npm", getNpmInstallArgs(host, [pkg], prefix), { env: env(root), encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		expect(existsSync(join(prefix, "node_modules", "scripted", "package.json"))).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it.skipIf(!npmAvailable)("control: the fixture's postinstall runs when scripts are allowed", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-ignore-scripts-"));
		dirs.push(root);
		const { pkg, marker } = fixture(root);
		const args = getNpmInstallArgs(host, [pkg], join(root, "prefix")).filter((arg) => arg !== "--ignore-scripts");
		const run = spawnSync("npm", args, { env: env(root), encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it.skipIf(!npmAvailable)("installs a git package's dependencies without running its postinstall", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-ignore-scripts-"));
		dirs.push(root);
		const { pkg, marker } = fixture(root);
		const run = spawnSync("npm", getGitDependencyInstallArgs(host), { cwd: pkg, env: env(root), encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});
});
