import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkAuthFileSafety } from "../src/core/auth-storage/file-safety.ts";

describe("checkAuthFileSafety", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "octocode-auth-safety-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function authFile(dir: string, mode: number): string {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "auth.json");
		writeFileSync(file, "{}");
		chmodSync(file, mode);
		return file;
	}

	test.skipIf(process.platform === "win32")("warns when auth.json is group or world readable", () => {
		const file = authFile(join(root, "home"), 0o644);
		const warnings = checkAuthFileSafety(file);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(file);
		expect(warnings[0]).toContain("chmod 600");
		expect(warnings[0]).toContain("644");
	});

	test.skipIf(process.platform === "win32")("warns for group-only access", () => {
		expect(checkAuthFileSafety(authFile(join(root, "home"), 0o640))).toHaveLength(1);
	});

	test.skipIf(process.platform === "win32")("is silent for a private file", () => {
		expect(checkAuthFileSafety(authFile(join(root, "home"), 0o600))).toEqual([]);
	});

	test("is silent when auth.json does not exist", () => {
		expect(checkAuthFileSafety(join(root, "missing", "auth.json"))).toEqual([]);
	});

	test.skipIf(process.platform === "win32")("warns when auth.json is inside a git work tree", () => {
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		const file = authFile(join(root, "repo", "config", "agent"), 0o600);
		const warnings = checkAuthFileSafety(file);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("git");
		expect(warnings[0]).toContain(join(root, "repo"));
	});

	test("treats a .git file (linked work tree) as a git work tree", () => {
		mkdirSync(join(root, "wt"), { recursive: true });
		writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere");
		const file = authFile(join(root, "wt", "agent"), 0o600);
		expect(checkAuthFileSafety(file, { platform: "win32" })).toHaveLength(1);
	});

	test("reports both problems and skips the mode check on Windows", () => {
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		const file = authFile(join(root, "repo"), 0o644);
		expect(checkAuthFileSafety(file, { platform: "linux" })).toHaveLength(2);
		expect(checkAuthFileSafety(file, { platform: "win32" })).toHaveLength(1);
	});
});
