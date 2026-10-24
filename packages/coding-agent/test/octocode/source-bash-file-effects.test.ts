import { beforeAll, describe, expect, it } from "vitest";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";

beforeAll(initializeBashSyntax);
const evaluate = (command: string, deny: string[]) =>
	evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { allow: ["Bash(*)"], deny } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "effects",
			active: true,
			input: { command },
		},
		"/work",
	).decision;

describe("shell-specific file rule projection", () => {
	it.each([
		"printf BLOCK > protected.txt",
		"printf BLOCK >> protected.txt",
		"printf BLOCK 2> protected.txt",
		"printf BLOCK | tee protected.txt",
	])("applies scoped Edit to output: %s", (command) => {
		expect(evaluate(command, ["Edit(./protected.txt)"])).toBe("deny");
	});
	it("applies scoped Read to input", () => {
		expect(evaluate("cat < protected.txt", ["Read(./protected.txt)"])).toBe("deny");
	});
	it.each([
		["printf BLOCK > protected.txt", "Read(./protected.txt)"],
		["cat < protected.txt", "Edit(./protected.txt)"],
		["printf BLOCK > protected.txt", "Edit"],
		["cat < protected.txt", "Read"],
	])("does not borrow direct-file cross-rule eligibility: %s %s", (command, rule) => {
		expect(evaluate(command, [rule])).toBe("allow");
	});
	it.each(["printf BLOCK > /dev/null", "printf BLOCK 2>&1", "cat <&3"])("excludes non-file targets: %s", (command) => {
		expect(evaluate(command, ["Read(**)", "Edit(**)"])).toBe("allow");
	});
});
it.each(["printf BLOCK >& protected.txt", "tee > /dev/null protected.txt"])(
	"accounts for filename redirects and interleaved tee operands: %s",
	(command) => {
		expect(evaluate(command, ["Edit(./protected.txt)"])).toBe("deny");
	},
);
it("does not cross-apply file asks or wildcard-only file tools", () => {
	const result = evaluateSourcePolicy(
		parseSourcePolicy(
			{
				permissions: {
					allow: ["Bash(*)"],
					ask: ["Edit(./protected.txt)", "Read(./protected.txt)"],
					deny: ["Edit(*)", "Read(*)"],
				},
			},
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "ask",
			active: true,
			input: { command: "cat < protected.txt > protected.txt" },
		},
		"/work",
	);
	expect(result.decision).toBe("allow");
});
it("retains explicit uncertainty when read-write redirection cannot be parsed", async () => {
	const { bashSyntax } = await import("../../src/octocode/permission/bash-syntax.ts");
	const result = bashSyntax("cat <> protected.txt");
	expect(result.incomplete).toBe(true);
	expect(result.targets).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "read", uncertain: expect.any(String) }),
			expect.objectContaining({ kind: "write", uncertain: expect.any(String) }),
		]),
	);
});
it("tracks cd effects without inventing a new working directory", async () => {
	const { bashSyntax } = await import("../../src/octocode/permission/bash-syntax.ts");
	expect(bashSyntax("cd sub; cat < input").targets[0]?.uncertain).toBe("relative target follows cd");
	for (const command of ["cd sub > output", "(cd sub); cat < input", "cd sub | cat; cat < input"]) {
		expect(bashSyntax(command).targets[0]?.uncertain).toBeUndefined();
	}
});
it("does not let an Edit allowance authorize the shell itself", () => {
	const result = evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { allow: ["Edit(./output)"] } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "allow",
			active: true,
			input: { command: "node -p 42 > output" },
		},
		"/work",
	);
	expect(result.decision).toBe("none");
	expect(result.shellTargets?.[0]?.allowed).toBe(true);
});
it("checks file rules without any Bash declaration", () => {
	const result = evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { deny: ["Edit(./output)"] } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "only-file",
			active: true,
			input: { command: "printf x > output" },
		},
		"/work",
	);
	expect(result.decision).toBe("deny");
});
it("does not let ignored file asks make broad Bash control flow unsupported", () => {
	const result = evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { allow: ["Bash(*)"], ask: ["Edit(./output)"] } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "only-ask",
			active: true,
			input: { command: "if true; then printf x > output; fi" },
		},
		"/work",
	);
	expect(result.decision).toBe("allow");
});
it("retains tee operands attached to a containing pipeline redirect", () => {
	expect(evaluate("printf x | tee > /dev/null protected.txt", ["Edit(./protected.txt)"])).toBe("deny");
});
it("combines a scoped Bash allowance with its target allowance", () => {
	const result = evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { allow: ["Bash(node *)", "Edit(./original.txt)"] } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{
			toolName: "bash",
			toolCallId: "scoped-target",
			active: true,
			input: { command: "node -p 42 > original.txt" },
		},
		"/work",
	);
	expect(result).toMatchObject({
		decision: "allow",
		shellTargets: [{ allowed: true }],
	});
});
it("matches target allowances when the accepted working directory has a canonical alias", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-file-alias-"));
	try {
		fs.mkdirSync(path.join(root, "actual"));
		fs.symlinkSync(path.join(root, "actual"), path.join(root, "alias"));
		const result = evaluateSourcePolicy(
			parseSourcePolicy(
				{ permissions: { allow: ["Bash(node *)", "Edit(./original.txt)"] } },
				{
					path: "/home/test/.claude/settings.json",
					anchor: "/home/test/.claude",
				},
			),
			{
				toolName: "bash",
				toolCallId: "alias",
				active: true,
				input: { command: "node -p 42 > original.txt" },
			},
			path.join(root, "alias"),
		);
		expect(result.decision).toBe("allow");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
it("discovers tee targets through the existing command wrapper projection", () => {
	expect(evaluate("printf x | command tee protected.txt", ["Edit(./protected.txt)"])).toBe("deny");
});
it.each(["Edit(./protected.txt)", "Read(./protected.txt)"])("does not run read-write redirection past %s", (rule) => {
	expect(evaluate("cat <> protected.txt", [rule])).toBe("unsupported");
});
