import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { changesOnlyWorkspace } from "../../src/octocode/permission/file-access.ts";
import { READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { tmp } from "./helpers.ts";

const cwd = fs.realpathSync(tmp());
execSync("git init -q", { cwd });
const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
beforeAll(() => shellParserReady());
const refused = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env);

describe("read-only role: programs that write or run code through options", () => {
	it.each([
		"base64 -i f -o src/x",
		"ctags -f src/x -R",
		"man -P 'touch src/x' ls",
		"tar -tf a --to-command='sh -c x'",
		"ssh -o ProxyCommand='touch x' host",
		"gh pr merge 1",
		"gh api -X POST repos/o/r/issues",
		"gh api repos/o/r/issues -f title=x",
		"gh pr checkout 1",
		"gh issue create --title x",
		"echo x > /usr/local/sibling/f",
		"rg x && gh pr merge 2",
	])("refuses %s", (command) => {
		expect(refused(command)).toBeDefined();
	});

	it.each([
		"rg foo src",
		"cat README.md",
		"git log -3",
		"gh pr view 1",
		"gh pr list --limit 5",
		"gh api repos/o/r/pulls",
		"gh search code foo",
		"base64 -i f",
		"man ls",
		"echo x > /dev/null",
		"echo x > /tmp/probe.txt",
	])("allows %s", (command) => {
		expect(refused(command)).toBeUndefined();
	});
});

describe("changesOnlyWorkspace", () => {
	it("treats a missing file as new and an unreadable one as unsafe", () => {
		expect(changesOnlyWorkspace(path.join(cwd, "new.txt"), cwd)).toBe(true);
		const locked = path.join(cwd, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "f"), "x");
		fs.chmodSync(locked, 0);
		try {
			if (process.getuid?.() !== 0) expect(changesOnlyWorkspace(path.join(locked, "f"), cwd)).toBe(false);
		} finally {
			fs.chmodSync(locked, 0o755);
		}
	});
});
