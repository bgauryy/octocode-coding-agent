import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliHost, probeCliHost, renderCliGuide } from "../../src/octocode/files/bash/cli-guide.ts";

const temps: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-guide-"));
	temps.push(dir);
	return dir;
}
function executable(dir: string, name: string, mode = 0o755): void {
	fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n");
	fs.chmodSync(path.join(dir, name), mode);
}
afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("probeCliHost", () => {
	it("lists executables on PATH, skips non-executable files and reports gh logged in from hosts.yml", () => {
		const bin = tempDir();
		const home = tempDir();
		for (const name of ["git", "rg", "gh"]) executable(bin, name);
		executable(bin, "jq", 0o644);
		fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: someone\n");
		const host = probeCliHost({ PATH: `${bin}:/nonexistent` }, "darwin", "arm64", home, false);
		expect(host.present).toEqual(["git", "rg", "gh"]);
		expect(host.missing).toContain("jq");
		expect(host.gh).toBe("ready");
	});

	it("tells an installed but logged-out gh from a missing one, and takes a token from the environment", () => {
		const bin = tempDir();
		const home = tempDir();
		executable(bin, "gh");
		expect(probeCliHost({ PATH: bin }, "linux", "x64", home).gh).toBe("logged-out");
		expect(probeCliHost({ PATH: bin, GH_TOKEN: "x" }, "linux", "x64", home).gh).toBe("ready");
		expect(probeCliHost({ PATH: tempDir() }, "linux", "x64", home).gh).toBe("absent");
	});

	it("resolves Windows names through PATHEXT and a case-insensitive Path key", () => {
		const bin = tempDir();
		fs.writeFileSync(path.join(bin, "rg.exe"), "");
		const host = probeCliHost({ Path: bin, PATHEXT: ".EXE;.CMD" }, "win32", "x64", tempDir(), false);
		expect(host.present).toEqual(["rg"]);
	});

	it("lists `octocode` only when the research CLI's shim is installed, never from PATH alone", () => {
		const bin = tempDir();
		executable(bin, "octocode");
		const home = tempDir();
		const withoutShim = probeCliHost({ PATH: bin }, "linux", "x64", home, false);
		expect(withoutShim.present).toEqual([]);
		expect(withoutShim.missing).not.toContain("octocode");
		expect(probeCliHost({ PATH: tempDir() }, "linux", "x64", home, true).present).toEqual(["octocode"]);
	});
});

describe("renderCliGuide", () => {
	const host = (platform: NodeJS.Platform, missing: string[] = []): CliHost => ({
		platform,
		arch: "arm64",
		present: ["git", "rg"],
		missing,
		gh: "ready",
	});

	it("opens with the probed host and gives only that platform's notes", () => {
		const mac = renderCliGuide(host("darwin", ["yq"]));
		// Read routing belongs to the research policy: the guide holds host facts only.
		expect(mac).not.toMatch(/Code research:|The commands below are for|^Find:|^Read:/m);
		expect(mac.split("\n")[0]).toBe(
			"Host: macOS arm64. On PATH: git, rg; not found: yq. gh: logged in. Check any other tool with `command -v` before relying on it.",
		);
		expect(mac).toContain("BSD tools");
		expect(mac).not.toContain("GNU tools");
		const linux = renderCliGuide(host("linux"));
		expect(linux.split("\n")[0]).toBe(
			"Host: Linux arm64. On PATH: git, rg. gh: logged in. Check any other tool with `command -v` before relying on it.",
		);
		expect(linux).toContain("sha256sum");
		expect(linux).not.toContain("BSD tools");
		expect(renderCliGuide(host("win32"))).toContain("type: powershell");
		expect(renderCliGuide(host("freebsd"))).toContain("Host notes: check flags");
	});

	it("lists the octocode CLI on PATH like any other program, without usage text", () => {
		const withCli = renderCliGuide({ ...host("linux"), present: ["git", "rg", "octocode"] });
		expect(withCli.split("\n")[0]).toContain("On PATH: git, rg, octocode.");
		expect(withCli).not.toContain("`octocode");
	});

	it("stays within ten lines", () => {
		for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
			expect(renderCliGuide(host(platform)).split("\n").length).toBeLessThanOrEqual(10);
			const withCli = { ...host(platform), present: ["git", "rg", "octocode"] };
			expect(renderCliGuide(withCli).split("\n").length).toBeLessThanOrEqual(10);
		}
	});
});
