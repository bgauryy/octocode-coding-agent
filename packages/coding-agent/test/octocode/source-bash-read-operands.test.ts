import { beforeAll, describe, expect, it } from "vitest";
import { bashSyntax, initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
beforeAll(initializeBashSyntax);
const evaluate = (command: string, target = "secret.txt") =>
	evaluateSourcePolicy(
		parseSourcePolicy(
			{ permissions: { allow: ["Bash(*)"], deny: [`Read(./${target})`] } },
			{
				path: "/home/test/.claude/settings.json",
				anchor: "/home/test/.claude",
			},
		),
		{ toolName: "bash", toolCallId: "read", active: true, input: { command } },
		"/work",
	);
describe("recognized Bash read operands", () => {
	it.each([
		"cat secret.txt",
		"cat -n secret.txt",
		"head -n 1 secret.txt",
		"tail -n 1 secret.txt",
		"wc -l secret.txt",
		"cat safe.txt secret.txt",
		"cat -- secret.txt",
		"cat 'secret.txt'",
		"command cat secret.txt",
		"cat > /dev/null secret.txt",
		"printf x | cat > /dev/null secret.txt",
	])("checks scoped Read before %s", (command) => {
		expect(evaluate(command).decision).toBe("deny");
	});
	it.each(["head -n 1 safe.txt", "tail -n 1 safe.txt", "head -c 1 safe.txt"])(
		"keeps numeric source candidates distinct from actual IO: %s",
		(command) => {
			expect(evaluate(command, "1").decision).toBe("deny");
			expect(bashSyntax(command).targets).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "1", policyOnly: true }),
					expect.objectContaining({ path: "safe.txt" }),
				]),
			);
		},
	);
	it.each(["cat -"])("does not treat stdin as a file: %s", (command) => {
		expect(bashSyntax(command).targets.some((target) => target.path === "-")).toBe(false);
	});
	it("preserves a dash-prefixed filename after the option delimiter", () => {
		expect(evaluate("cat -- -secret", "-secret").decision).toBe("deny");
	});
	it.each([
		"cat safe.txt -n secret.txt",
		"head '-n' 1 secret.txt",
		"tail +1 secret.txt",
		"wc -- secret.txt",
		"command head -n 1 secret.txt",
		"printf x | wc > /dev/null secret.txt",
		"cat $(printf secret.txt)",
	])("accounts for operand forms: %s", (command) => {
		expect(["deny", "unsupported"]).toContain(evaluate(command).decision);
	});
	it.each(["wc --files0-from=names", "cat --unknown safe.txt", 'cat "$TARGET"'])(
		"refuses uncertain reads under scoped restrictions: %s",
		(command) => {
			expect(evaluate(command).decision).toBe("unsupported");
		},
	);
	it.each(["head", "tail"])("does not require an allowance for %s's count", (reader) => {
		const decision = evaluateSourcePolicy(
			parseSourcePolicy(
				{ permissions: { allow: [`Bash(${reader} *)`, "Read(./safe.txt)"] } },
				{
					path: "/home/test/.claude/settings.json",
					anchor: "/home/test/.claude",
				},
			),
			{
				toolName: "bash",
				toolCallId: "read",
				active: true,
				input: { command: `${reader} -n 1 safe.txt` },
			},
			"/work",
		);
		expect(decision.decision).toBe("allow");
		expect(decision.shellTargets).toEqual([expect.objectContaining({ path: "safe.txt", allowed: true })]);
	});
	it("does not grant an actual operand using a count allowance", () => {
		const decision = evaluateSourcePolicy(
			parseSourcePolicy(
				{ permissions: { allow: ["Bash(head *)", "Read(./1)"] } },
				{
					path: "/home/test/.claude/settings.json",
					anchor: "/home/test/.claude",
				},
			),
			{
				toolName: "bash",
				toolCallId: "read",
				active: true,
				input: { command: "head -n 1 secret.txt" },
			},
			"/work",
		);
		expect(decision.decision).toBe("none");
	});
	it("keeps head's plus-prefixed filename as an actual read", () => {
		expect(bashSyntax("head +1 safe.txt").targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "+1" })]),
		);
	});
	it("does not consume a missing count as the option delimiter", () => {
		expect(bashSyntax("head -n -- safe.txt").targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ raw: "--", uncertain: "unknown read count" })]),
		);
	});
	it("retains tail legacy counts only for source denial", () => {
		expect(evaluate("tail +1 safe.txt", "+1").decision).toBe("deny");
		expect(bashSyntax("tail +1 safe.txt").targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "+1", policyOnly: true })]),
		);
	});
	it.skipIf(process.platform !== "darwin")("retains BSD operands after the first filename", () => {
		const targets = bashSyntax("head safe.txt -n 1").targets;
		expect(targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "-n" }), expect.objectContaining({ path: "1" })]),
		);
		expect(targets.find((target) => target.path === "1")?.policyOnly).not.toBe(true);
	});
	it("terminates cat option processing after stdin", () => {
		expect(bashSyntax("cat - -n").targets).toEqual(expect.arrayContaining([expect.objectContaining({ path: "-n" })]));
	});
	it.skipIf(process.platform !== "darwin").each(["head -", "tail -", "wc -"])(
		"keeps BSD dash filename in %s",
		(command) => {
			expect(bashSyntax(command).targets).toEqual(expect.arrayContaining([expect.objectContaining({ path: "-" })]));
		},
	);
});
