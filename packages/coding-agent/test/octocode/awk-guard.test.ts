import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_SCRATCH_ENV,
	PERMISSION_ENV,
	READ_ONLY_ENV,
	SUBAGENT_ENV,
	TEAM_WORKSPACE_ENV,
} from "@octocodeai/octocode-common/env";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { awkEffect } from "../../src/octocode/permission/shell/awk-program.ts";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * The awk reading of the shell guard (`shell/awk-program.ts`): docs/permissions.md says an awk call is read only through
 * a fail-safe allowlist, for every awk the guard knows; anything else (an option, a program file, a `>` or `|` in the
 * program) makes the call uncertain, as sed's `-f` script is.
 */

beforeAll(shellParserReady);

function repo(): string {
	const dir = fs.realpathSync(tmp());
	execSync("git init -q", { cwd: dir });
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src/a.ts"), "original");
	return dir;
}

const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
const refusal = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, repo(), env);

describe("every awk the guard knows reads its program", () => {
	it.each([
		[`mawk '{ print > "src/a.ts" }' src/a.ts`],
		[`nawk '{ print > "src/a.ts" }' src/a.ts`],
		[`busybox awk '{ print > "src/a.ts" }' src/a.ts`],
		[`gawk '{ print > "src/a.ts" }' src/a.ts`],
	])("refuses %j in a read-only child", (command) => {
		expect(refusal(command)).toMatch(/read-only role/);
	});

	it.each([
		[`mawk '{ print $1 }' src/a.ts`],
		[`nawk '{ print $1 }' src/a.ts`],
		[`busybox awk '{ print $1 }' src/a.ts`],
	])("still lets a read-only child print with %j (guard)", (command) => {
		expect(refusal(command)).toBeUndefined();
	});

	it("reads `busybox awk -i inplace` as busybox's awk, not as busybox", () => {
		expect(awkEffect("busybox", ["awk", "-i", "inplace", "{ print }", "src/a.ts"])).toMatchObject({
			inPlace: { files: ["src/a.ts"] },
		});
		expect(awkEffect("busybox", ["sed", "-i", "s/a/b/", "src/a.ts"])).toBeUndefined();
	});

	it("reads an abbreviated `--incl=inplace` as gawk's in-place edit, not as a library", () => {
		expect(awkEffect("gawk", ["--incl=inplace", "{ print }", "src/a.ts"])).toMatchObject({
			inPlace: { files: ["src/a.ts"] },
		});
		expect(awkEffect("gawk", ["--incl", "inplace", "{ print }", "src/a.ts"])).toMatchObject({
			inPlace: { files: ["src/a.ts"] },
		});
	});

	// Workspace reservations and receipts read the in-place operands whatever other options come with them: an option
	// outside the allowlist keeps the strict reason but must not hide what `-i inplace` rewrites.
	it.each([
		[["-b", "-i", "inplace", "{ print }", "src/a.ts"]],
		[["-i", "inplace", "-b", "{ print }", "src/a.ts"]],
		[["--posix", "--include=inplace", "{ print }", "src/a.ts"]],
		[["-i", "inplace", "-W", "posix", "{ print }", "src/a.ts"]],
	])("keeps the in-place targets of gawk %j next to an option outside the allowlist", (words) => {
		const effect = awkEffect("gawk", words);
		expect(effect?.inPlace?.files).toEqual(["src/a.ts"]);
		expect(effect?.because).toMatch(/outside the options the guard reads/);
	});

	it("reads every operand as an in-place target when the program comes from a file", () => {
		const effect = awkEffect("gawk", ["-f", "p.awk", "-i", "inplace", "src/a.ts", "src/b.ts"]);
		expect(effect?.inPlace?.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(effect?.because).toBeDefined();
	});
});

describe("an awk program the guard cannot read is uncertain", () => {
	it.each([
		[`awk -f /tmp/p.awk src/a.ts`],
		[`awk -f/tmp/p.awk src/a.ts`],
		[`awk --file=/tmp/p.awk src/a.ts`],
		[`awk --file /tmp/p.awk src/a.ts`],
		[`gawk -E /tmp/p.awk src/a.ts`],
		[`gawk '@include "lib"; { print }' src/a.ts`],
		[`gawk '@load "rwarray"; BEGIN { writea("f", a) }' src/a.ts`],
	])("marks %j uncertain for the strict callers, as sed -f is", (command) => {
		expect(shellMutation(command).awkUnread).toMatch(/awk's program/);
	});

	it("refuses `awk -f` in a read-only child", () => {
		expect(refusal(`awk -f /tmp/p.awk src/a.ts`)).toMatch(/read-only role/);
	});
});

/**
 * The fail-safe cost: a `>` or `|` in a comparison, regex or string, a redirect to a standard stream, and every long or
 * `-W` option make the call uncertain, though they write nothing. A read-only child uses rg, jq or a script instead.
 */
describe("awk's fail-safe allowlist does not tell harmless forms apart", () => {
	it.each([
		[`awk '/error|warn/ { print }' src/a.ts`],
		[`awk '$1 ~ /a|b/ { print }' src/a.ts`],
		[`awk '{ if (/x>y/) print }' src/a.ts`],
		[`awk 'NR > 1 && /a|b/ { print }' src/a.ts`],
		[`awk '{ x = /a|b/ ? 1 : 0; print x }' src/a.ts`],
		[`awk '{ print > "/dev/stderr" }' src/a.ts`],
		[`awk '{ printf "%s", $1 >> "/dev/stderr" }' src/a.ts`],
		[`mawk -W interactive '{ print $1 }' src/a.ts`],
		[`gawk --field-separator : '{ print $1 }' src/a.ts`],
		[`gawk --assign x=1 '{ print x }' src/a.ts`],
	])("refuses %j in a read-only child", (command) => {
		expect(refusal(command)).toMatch(/read-only role/);
	});
});

/**
 * The fail-safe allowlist: an awk call is read only with `-F`, `-v` and `--` for options and a program whose raw text has
 * no `>`, `|`, `@`, `system`, `getline`, `close`, `fflush` or backslash-newline. Every bypass phases C and D confirmed
 * against the literal-aware reader is refused here.
 */
describe("awk's fail-safe allowlist refuses every confirmed bypass", () => {
	it.each([
		// A regex where the old reader saw a division (after `=`, `?`, `:`, `return`, `print`, and a control condition).
		[`awk '{ x = 4 / 2 /"/; print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk '{ x = /"/; print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk '{ x = $1 ? /"/ : 0; print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk '{ x = $1 ? 0 : /"/; print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk 'function f() { return /"/ } { print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk '{ print /"/; print > "src/a.ts"; y = "z" }' src/a.ts`],
		[`awk '{ if (1) /"/ ; print > "src/a.ts" }' src/a.ts`],
		[`awk '{ while (0) /"/ ; print > "src/a.ts" }' src/a.ts`],
		[`awk '{ for (i = 0; i < 1; i++) /"/ ; print > "src/a.ts" }' src/a.ts`],
		// Program files, libraries and extensions, abbreviated or bundled.
		[`gawk --fil /tmp/p.awk src/a.ts`],
		[`gawk --incl lib '{ print }' src/a.ts`],
		[`mawk -W exec /tmp/p.awk src/a.ts`],
		[`mawk -Wexec /tmp/p.awk src/a.ts`],
		[`gawk -i lib '{ print }' src/a.ts`],
		[`gawk -l ext '{ print }' src/a.ts`],
		[`gawk -bf /tmp/p.awk src/a.ts`],
		[`awk -bf /tmp/p.awk src/a.ts`],
		[`gawk -nf /tmp/p.awk src/a.ts`],
		[`gawk -Sf /tmp/p.awk src/a.ts`],
		[`gawk -bi lib '{ print }' src/a.ts`],
		[`gawk -bl ext '{ print }' src/a.ts`],
		[`gawk -bW exec /tmp/p.awk src/a.ts`],
		[`gawk -e '{ print }' src/a.ts`],
		[`gawk -D '{ print }' src/a.ts`],
		// gawk's own output files, with and without a file named.
		[`gawk -osrc/a.ts '{ print }' src/a.ts`],
		[`gawk -o '{ print }' src/a.ts`],
		[`gawk -psrc/a.ts '{ print }' src/a.ts`],
		[`gawk -p '{ print }' src/a.ts`],
		[`gawk -dsrc/a.ts '{ print }' src/a.ts`],
		[`gawk -d '{ print }' src/a.ts`],
		[`gawk --pretty-print=src/a.ts '{ print }' src/a.ts`],
		[`gawk --profile=src/a.ts '{ print }' src/a.ts`],
		[`gawk --dump-variables=src/a.ts '{ print }' src/a.ts`],
		[`gawk --dump-variables '{ print }' src/a.ts`],
		// Commands and redirects in the program.
		[`gawk '{ f = "system"; @f("touch src/b") }' src/a.ts`],
		[`awk 'BEGIN { system("touch src/b") }'`],
		[`awk '{ print > "src/a.ts" }' src/a.ts`],
		[`awk '{ print | "sh" }' src/a.ts`],
		[`awk 'BEGIN { "date" | getline d; print d }'`],
		[`awk 'BEGIN { while ((getline line < "src/a.ts") > 0) n++ }'`],
		[`awk '{ print > "/dev/stderr" "x" }' src/a.ts`],
		[`awk '{ print $0 \\\n > "src/a.ts" }' src/a.ts`],
	])("refuses %j in a read-only child", (command) => {
		expect(refusal(command)).toMatch(/read-only role/);
	});

	it.each([
		[`awk 'BEGIN { getline; print }' src/a.ts`],
		[`awk '{ close("x") }' src/a.ts`],
		[`awk '{ fflush() }' src/a.ts`],
		[`awk '$1 > 5' src/a.ts`],
		[`awk "$PROG" src/a.ts`],
	])("marks %j uncertain: a word the allowlist does not read, or a program it cannot see", (command) => {
		expect(shellMutation(command).awkUnread).toMatch(/awk/);
	});

	it.each([
		[`awk -F: '{print $1}' src/a.ts`],
		[`awk -F : '{print $1}' src/a.ts`],
		[`awk -v x=1 '{ print x, $1 }' src/a.ts`],
		[`awk -vx=1 '{ print x }' src/a.ts`],
		[`awk -- '{ print $2 }' src/a.ts`],
		[`awk -F'|' '{ print $1 }' src/a.ts`],
		[`awk 'NR==2' src/a.ts`],
		[`gawk '{ print $1 / 2 }' src/a.ts`],
		[`busybox awk -F, '{ print $3 }' src/a.ts`],
	])("still lets a read-only child read with %j (guard)", (command) => {
		expect(refusal(command)).toBeUndefined();
	});
});

/** An isolated child of a fresh main tree: `isolatedTreeRefusal` for `command`, with `MAIN` replaced by that tree. */
function isolatedRefusal(command: string): string | undefined {
	const main = repo();
	const scratch = path.join(main, ".octocode/agent/temp/agents/impl-1");
	fs.mkdirSync(scratch, { recursive: true });
	const childEnv = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main, [AGENT_SCRATCH_ENV]: scratch };
	const event = { toolName: "bash", input: { command: command.replaceAll("MAIN", main) } };
	return isolatedTreeRefusal(event, repo(), childEnv);
}

/**
 * The value word of `-F` or `-v` is read only when it is a literal: an expansion, brace expansion, glob or command
 * substitution can split into several words (`-f /dev/stdin`), so the program would come from a here-string the guard
 * never reads. A missing value is uncertain too.
 */
describe("an expansion as the value of -F or -v makes the awk call uncertain", () => {
	const stdin = `<<< 'BEGIN { system("touch src/b") }'`;
	it.each([
		[`awk -v {x=1,-f,/dev/stdin} '{print}' src/a.ts ${stdin}`],
		[`awk -F {x,-f,/dev/stdin} '{print}' src/a.ts ${stdin}`],
		[`X='x=1 -f /dev/stdin'; awk -v $X '{print}' src/a.ts ${stdin}`],
		[`X='x -f /dev/stdin'; awk -F $X '{print}' src/a.ts ${stdin}`],
		[`awk -v $(printf 'x=1 -f /dev/stdin') '{print}' src/a.ts ${stdin}`],
		[`awk -v * '{print}' src/a.ts`],
		[`awk -F * '{print}' src/a.ts`],
		[`awk -v`],
		[`awk -F`],
	])("refuses %j in a read-only child", (command) => {
		expect(refusal(command)).toMatch(/read-only role/);
	});

	it.each([
		[`awk -v {x=1,-f,/dev/stdin} '{print}' f <<< 'BEGIN { system("touch MAIN/x") }'`],
		[`X='x=1 -f /dev/stdin'; awk -v $X '{print}' f <<< 'BEGIN { system("touch MAIN/x") }'`],
		[`X='x -f /dev/stdin'; awk -F $X '{print}' f <<< 'BEGIN { system("touch MAIN/x") }'`],
	])("refuses %j in an isolated child", (command) => {
		expect(isolatedRefusal(command)).toMatch(/isolated/);
	});

	it("still refuses the plain here-string program `awk -f /dev/stdin` (guard)", () => {
		expect(refusal(`awk -f /dev/stdin src/a.ts ${stdin}`)).toMatch(/read-only role/);
	});
});

/** Every awk binary by its name's pattern: any name ending in `awk`, versioned names, and the toybox and busybox applets, also behind a wrapper. */
describe("awk is matched by name pattern", () => {
	it.each([
		[`original-awk 'BEGIN { print > "src/a.ts" }'`],
		[`goawk 'BEGIN { system("touch src/b") }'`],
		[`/usr/local/bin/goawk 'BEGIN { system("touch src/b") }'`],
		[`toybox awk -f /tmp/p.awk src/a.ts`],
		[`busybox awk -f /tmp/p.awk src/a.ts`],
		[`gawk-5.3.1 -f /tmp/p.awk src/a.ts`],
		[`awk-20200816 -f /tmp/p.awk src/a.ts`],
		[`mawk-1.3.4 -f /tmp/p.awk src/a.ts`],
		[`env goawk 'BEGIN { system("touch src/b") }'`],
		[`command original-awk 'BEGIN { print > "src/a.ts" }'`],
		[`nice -n 5 gawk-5.3.1 -f /tmp/p.awk src/a.ts`],
		[`echo src/a.ts | xargs goawk`],
	])("refuses %j in a read-only child", (command) => {
		expect(refusal(command)).toMatch(/read-only role/);
	});

	it("refuses goawk's system() into the main tree in an isolated child", () => {
		expect(isolatedRefusal(`goawk 'BEGIN { system("touch MAIN/x") }'`)).toMatch(/isolated/);
	});

	it.each([[`goawk '{ print $1 }' src/a.ts`], [`toybox awk -F: '{ print $1 }' src/a.ts`]])(
		"still lets a read-only child read with %j (guard)",
		(command) => {
			expect(refusal(command)).toBeUndefined();
		},
	);
});

/**
 * gawk finds `inplace.awk` through AWKPATH, which looks in `.` first and which the command can set: `-i inplace` loads
 * code the guard does not read, so the strict callers treat it as uncertain while its operands stay targets.
 */
describe("gawk -i inplace is uncertain for the strict callers", () => {
	it.each([
		[`AWKPATH=MAIN gawk -i inplace '{print}' f`],
		[`export AWKPATH=MAIN; gawk --include=inplace '{print}' f`],
		[`env AWKPATH=MAIN gawk -iinplace '{print}' f`],
		[`AWKPATH=MAIN; gawk --incl inplace '{print}' f`],
	])("refuses %j in an isolated child", (command) => {
		expect(isolatedRefusal(command)).toMatch(/isolated/);
	});

	it("marks plain `gawk -i inplace` uncertain for the strict callers and keeps its operands", () => {
		const found = shellMutation(`gawk -i inplace '{print}' a.txt`);
		expect(found.awkUnread).toMatch(/AWKPATH/);
		expect(found.writes).toEqual(["a.txt"]);
		expect(found.uncertain).toBe(false);
	});
});

/**
 * The strict allowlist is for the read-only role and the isolated-tree guard only. `workspace` reads awk as it did
 * before: an in-place edit, but not the program, so a plain read does not ask there.
 */
describe("awk's strict allowlist applies only to the read-only role and the isolated-tree guard", () => {
	function workspace() {
		const cwd = repo();
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
		const ctx = fakeCtx({ cwd, hasUI: false });
		permission.start(ctx);
		const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
		let id = 0;
		return (command: string) =>
			gate({ type: "tool_call", toolCallId: `w${id++}`, toolName: "bash", input: { command } }, ctx);
	}

	it.each([[`awk '$1 > 5' src/a.ts`], [`awk '/a|b/' src/a.ts`]])(
		"runs %j unasked in a workspace session, while a read-only child refuses it",
		async (command) => {
			expect(await workspace()(command)).toBeUndefined();
			expect(shellMutation(command).uncertain).toBe(false);
			expect(refusal(command)).toMatch(/read-only role/);
		},
	);
});
