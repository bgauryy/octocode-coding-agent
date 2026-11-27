import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
import { tmp } from "./helpers.ts";

/**
 * Letter case in Claude path rules: an allow rule matches the exact case it names, so on a case-sensitive filesystem
 * `Edit(docs/**)` does not approve the different directory `DOCS/`; deny and ask rules match any case, and on a
 * case-insensitive volume a path spelled in another case still meets them (the evaluation the permission gate runs
 * through `registerSourcePolicy`'s `evaluate`).
 */
beforeAll(initializeBashSyntax);

const source = { path: "/home/test/.claude/settings.json", anchor: "/home/test/.claude" };
const write = (file: string): Parameters<typeof evaluateSourcePolicy>[1] => ({
	toolName: "file",
	input: { queries: [{ type: "write", path: file, content: "x" }] },
	toolCallId: "one",
	active: true,
});
const read = (file: string): Parameters<typeof evaluateSourcePolicy>[1] => ({
	toolName: "read",
	input: { path: file },
	toolCallId: "one",
	active: true,
});
const decide = (rules: Record<string, string[]>, call: Parameters<typeof evaluateSourcePolicy>[1], cwd: string) =>
	evaluateSourcePolicy(parseSourcePolicy({ permissions: rules }, source), call, cwd).decision;

describe("letter case in path rules", () => {
	it("allows only the exact case an allow rule names", () => {
		const cwd = fs.realpathSync.native(tmp());
		expect(decide({ allow: ["Edit(docs/**)"] }, write("docs/x.md"), cwd)).toBe("allow");
		expect(decide({ allow: ["Edit(docs/**)"] }, write("DOCS/x.md"), cwd)).toBe("none");
		expect(decide({ allow: ["Edit(docs/**)"] }, write("Docs/x.md"), cwd)).toBe("none");
	});

	it("denies and asks for any case", () => {
		const cwd = fs.realpathSync.native(tmp());
		expect(decide({ deny: ["Edit(docs/**)"] }, write("DOCS/x.md"), cwd)).toBe("deny");
		expect(decide({ ask: ["Edit(docs/**)"] }, write("Docs/x.md"), cwd)).toBe("ask");
	});

	// On a case-insensitive volume (macOS default) a path whose directories are spelled in another case is the same file.
	it("denies a read of the denied file reached through a differently cased directory", () => {
		const cwd = fs.realpathSync.native(tmp());
		fs.writeFileSync(path.join(cwd, "README.md"), "secret");
		const upper = path.join(path.dirname(cwd).toUpperCase(), path.basename(cwd), "README.md");
		if (!fs.existsSync(upper)) return; // a case-sensitive filesystem: the spelling names another file
		expect(decide({ deny: ["Read(README.md)"] }, read(upper), cwd)).toBe("deny");
		expect(decide({ allow: ["Read(README.md)"] }, read(upper), cwd)).toBe("none");
	});
});
