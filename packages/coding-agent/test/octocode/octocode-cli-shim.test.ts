import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBinDir } from "../../src/config.ts";
import { resolveOctocodeCli } from "../../src/octocode/cli/resolve.ts";
import { shimFiles, writeOctocodeShim } from "../../src/octocode/cli/shim.ts";
import { getShellEnv, setShellPathEntries } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";

afterEach(() => setShellPathEntries(() => []));

/** A project with an `octocode` dependency whose manifest is `manifest`; returns a file to resolve from. */
function project(manifest: Record<string, unknown>, binFile?: string): string {
	const dir = tmp();
	const pkg = path.join(dir, "node_modules", "octocode");
	fs.mkdirSync(path.join(pkg, "out"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "octocode", ...manifest }));
	if (binFile) fs.writeFileSync(path.join(pkg, binFile), "");
	return path.join(dir, "index.js");
}

describe("resolveOctocodeCli", () => {
	it("returns the dependency's bin and version", () => {
		const from = project({ version: "9.9.9", bin: "./out/octocode.js" }, "out/octocode.js");
		const cli = resolveOctocodeCli(from);
		expect(cli?.version).toBe("9.9.9");
		expect(fs.realpathSync(cli!.bin)).toBe(
			fs.realpathSync(path.join(path.dirname(from), "node_modules/octocode/out/octocode.js")),
		);
		expect(resolveOctocodeCli(project({ version: "1.0.0", bin: { octocode: "out/x.js" } }, "out/x.js"))?.version).toBe(
			"1.0.0",
		);
	});

	it("is undefined when the package is missing, names no bin, or its bin is not built", () => {
		expect(resolveOctocodeCli(path.join(tmp(), "index.js"))).toBeUndefined();
		expect(resolveOctocodeCli(project({ version: "1.0.0" }))).toBeUndefined();
		expect(resolveOctocodeCli(project({ version: "1.0.0", bin: "./out/octocode.js" }))).toBeUndefined();
	});

	it("finds the package by folder, whatever its exports, from a file URL too", () => {
		// octocode's published shape: `require` resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED for it.
		const importOnly = { exports: { ".": { import: "./out/octocode.js" } } };
		const from = project({ version: "2.0.0", bin: "./out/octocode.js", ...importOnly }, "out/octocode.js");
		expect(resolveOctocodeCli(from)?.version).toBe("2.0.0");
		expect(resolveOctocodeCli(pathToFileURL(from).href)?.version).toBe("2.0.0");
		const invalid = { exports: { ".": "./out/octocode.js", x: "./x.js" } }; // ERR_INVALID_PACKAGE_CONFIG
		expect(
			resolveOctocodeCli(project({ version: "3.0.0", bin: "out/octocode.js", ...invalid }, "out/octocode.js")),
		).toEqual(expect.objectContaining({ version: "3.0.0" }));
	});

	it("is undefined, without throwing, for a malformed or foreign manifest", () => {
		const from = project({ version: "1.0.0", bin: "./out/octocode.js" }, "out/octocode.js");
		const manifest = path.join(path.dirname(from), "node_modules", "octocode", "package.json");
		fs.writeFileSync(manifest, '{"name": "octocode", "bin": ');
		expect(resolveOctocodeCli(from)).toBeUndefined();
		fs.writeFileSync(manifest, JSON.stringify({ name: "other", version: "1.0.0", bin: "./out/octocode.js" }));
		expect(resolveOctocodeCli(from)).toBeUndefined();
		fs.rmSync(manifest);
		expect(resolveOctocodeCli(from)).toBeUndefined();
	});

	it("resolves the linked research CLI from this package", () => {
		const cli = resolveOctocodeCli();
		expect(cli).toBeDefined();
		expect(fs.existsSync(cli!.bin)).toBe(true);
	});
});

describe("the agent shell shims", () => {
	const cli = { bin: "/opt/it's/octocode.js", version: "1.2.3" };
	const agent = { command: "/usr/bin/node", prefix: ["--import", "file:///a/resolver.ts", "/a/src/cli.ts"] };

	it("runs the coding agent as `octocode` and the research CLI as `octocode-cli`, quoting every word", () => {
		const files = shimFiles(cli, "/usr/bin/node", "darwin", agent);
		expect(Object.keys(files).sort()).toEqual(["octocode", "octocode-cli"]);
		expect(files.octocode.startsWith("#!/bin/sh\n")).toBe(true);
		expect(files.octocode).toContain(`exec '/usr/bin/node' '--import' 'file:///a/resolver.ts' '/a/src/cli.ts' "$@"\n`);
		expect(files["octocode-cli"]).toContain(`exec '/usr/bin/node' '/opt/it'\\''s/octocode.js' "$@"\n`);
	});

	it("writes only `octocode` when the research CLI is missing", () => {
		expect(Object.keys(shimFiles(undefined, "node", "linux", agent))).toEqual(["octocode"]);
	});

	it("adds a .cmd for each on Windows", () => {
		const files = shimFiles({ bin: "C:\\o\\octocode.js", version: "1" }, "C:\\node.exe", "win32", {
			command: "C:\\node.exe",
			prefix: ["C:\\a\\cli.js"],
		});
		expect(Object.keys(files).sort()).toEqual(["octocode", "octocode-cli", "octocode-cli.cmd", "octocode.cmd"]);
		expect(files["octocode-cli.cmd"]).toBe('@echo off\r\n"C:\\node.exe" "C:\\o\\octocode.js" %*\r\n');
		expect(files["octocode.cmd"]).toBe('@echo off\r\n"C:\\node.exe" "C:\\a\\cli.js" %*\r\n');
	});

	it("doubles % in the .cmd paths so cmd.exe does not expand them", () => {
		const files = shimFiles(
			{ bin: "C:\\100%\\%PATH%\\octocode.js", version: "1" },
			"C:\\n%o\\node.exe",
			"win32",
			agent,
		);
		expect(files["octocode-cli.cmd"]).toBe(
			'@echo off\r\n"C:\\n%%o\\node.exe" "C:\\100%%\\%%PATH%%\\octocode.js" %*\r\n',
		);
	});

	it("writes executable scripts in their own folder, per runtime, bin and entry, and leaves unchanged ones alone", () => {
		const root = tmp();
		const dir = writeOctocodeShim(cli, root, "/usr/bin/node", "linux", agent);
		expect(path.dirname(dir)).toBe(root);
		const expected = shimFiles(cli, "/usr/bin/node", "linux", agent);
		for (const name of ["octocode", "octocode-cli"]) {
			const file = path.join(dir, name);
			expect(fs.readFileSync(file, "utf8")).toBe(expected[name]);
			expect(fs.statSync(file).mode & 0o111).not.toBe(0);
		}
		const written = fs.statSync(path.join(dir, "octocode")).ino;
		expect(writeOctocodeShim(cli, root, "/usr/bin/node", "linux", agent)).toBe(dir);
		expect(fs.statSync(path.join(dir, "octocode")).ino).toBe(written);
		expect(writeOctocodeShim({ ...cli, bin: "/other.js" }, root, "/usr/bin/node", "linux", agent)).not.toBe(dir);
		expect(writeOctocodeShim(cli, root, "/usr/bin/node", "linux", { ...agent, prefix: ["/b/cli.js"] })).not.toBe(dir);
		expect(fs.readdirSync(dir).sort()).toEqual(["octocode", "octocode-cli"]);
	});

	it("comes first on the shell path, before Octocode's bin", () => {
		const dir = tmp();
		setShellPathEntries(() => [dir]);
		const entries = (getShellEnv().PATH ?? "").split(path.delimiter);
		expect(entries[0]).toBe(dir);
		expect(entries.indexOf(getBinDir())).toBeGreaterThan(0);
		expect(entries.filter((entry) => entry === dir)).toHaveLength(1);
	});

	it("records a resolution failure once and leaves shells working", async () => {
		vi.resetModules();
		const resolve = vi.fn(() => {
			throw Object.assign(new Error("bad package"), { code: "ERR_INVALID_PACKAGE_CONFIG" });
		});
		vi.doMock("../../src/octocode/cli/resolve.ts", () => ({ resolveOctocodeCli: resolve, cliRuntime: () => "node" }));
		try {
			const fresh = await import("../../src/octocode/cli/shim.ts");
			setShellPathEntries(() => [fresh.octocodeShimDir()].filter((dir) => dir !== undefined));
			expect(getShellEnv().PATH).toContain(getBinDir());
			expect(getShellEnv().PATH).toContain(getBinDir());
			expect(fresh.octocodeCliAvailable()).toBe(false);
			expect(fresh.octocodeShimError()).toMatch(/octocode shim .*bad package/);
			expect(resolve).toHaveBeenCalledTimes(1);
		} finally {
			vi.doUnmock("../../src/octocode/cli/resolve.ts");
			vi.resetModules();
		}
	});

	it.skipIf(process.platform === "win32")(
		"runs the agent as `octocode` and the research CLI as `octocode-cli` in a shell built from getShellEnv",
		() => {
			const real = resolveOctocodeCli()!;
			const dir = writeOctocodeShim(real, tmp());
			setShellPathEntries(() => [dir]);
			const run = (command: string) => spawnSync("/bin/sh", ["-c", command], { env: getShellEnv(), encoding: "utf8" });
			const research = run("octocode-cli --version");
			expect(research.status).toBe(0);
			// The CLI may append its build id (`+c6361757`) to the package version.
			expect(research.stdout.trim()).toMatch(new RegExp(`^octocode ${real.version.replaceAll(".", "\\.")}(\\+[0-9A-Za-z.-]+)?$`));
			const agentHelp = run("octocode context --help");
			expect(agentHelp.status).toBe(0);
			expect(agentHelp.stdout).toMatch(/context/i);
		},
		60_000,
	);
});
