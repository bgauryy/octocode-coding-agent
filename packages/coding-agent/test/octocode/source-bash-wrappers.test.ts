import { beforeAll, describe, expect, it } from "vitest";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
beforeAll(initializeBashSyntax);
const source = {
	path: "/home/test/.claude/settings.json",
	anchor: "/home/test/.claude",
};
const evaluate = (command: string, permissions: Record<string, string[]>) =>
	evaluateSourcePolicy(
		parseSourcePolicy({ permissions }, source),
		{
			toolName: "bash",
			toolCallId: "wrapper",
			active: true,
			input: { command },
		},
		"/work",
	).decision;
describe("Claude Bash wrapper matching", () => {
	it.each([
		"timeout 30 printf BLOCK",
		"time printf BLOCK",
		"nice -n 4 printf BLOCK",
		"nohup printf BLOCK",
		"stdbuf -oL printf BLOCK",
		"command printf BLOCK",
		"builtin printf BLOCK",
		"noglob printf BLOCK",
		"xargs printf BLOCK",
	])("matches the executable beneath a documented wrapper: %s", (command) => {
		expect(evaluate(command, { deny: ["Bash(printf BLOCK*)"] })).toBe("deny");
	});
	it.each(["command -v printf", "xargs -n1 printf SAFE", "nocorrect printf SAFE", "npx printf SAFE"])(
		"does not unwrap a nonexecuting or excluded form: %s",
		(command) => {
			expect(evaluate(command, { deny: ["Bash(printf *)"] })).toBe("none");
		},
	);
	it("strips safe assignments for allow and any assignment for restrictions", () => {
		expect(evaluate("NODE_ENV=test printf SAFE", { allow: ["Bash(printf SAFE)"] })).toBe("allow");
		expect(
			evaluate("OCTOCODE_UNKNOWN=value printf SAFE", {
				allow: ["Bash(printf SAFE)"],
			}),
		).toBe("none");
		expect(
			evaluate("OCTOCODE_UNKNOWN=value printf BLOCK", {
				deny: ["Bash(printf BLOCK*)"],
			}),
		).toBe("deny");
	});
	it.each([
		"watch printf SAFE",
		"setsid printf SAFE",
		"ionice printf SAFE",
		"flock lock printf SAFE",
		"find . -delete",
	])("does not autoapprove an effectful prefix but permits exact source allowance: %s", (command) => {
		const prefix = command.split(" ")[0];
		expect(evaluate(command, { allow: [`Bash(${prefix} *)`] })).toBe("none");
		expect(evaluate(command, { allow: [`Bash(${command})`] })).toBe("allow");
	});
	it("keeps ordinary find queries eligible for prefix matching", () => {
		expect(evaluate("find . -type f", { allow: ["Bash(find *)"] })).toBe("allow");
	});
});
it.each(["nice -n3 node -p 42", "time -p node -p 42", "stdbuf -o L node -p 42", "stdbuf --output=L node -p 42"])(
	"does not inherit an inner allowance for observed unstripped options: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(node -p 42)"] })).toBe("none");
	},
);
it.each(['nice "node" -p 42', "nice n\\ode -p 42"])(
	"matches the observed normalized wrapper executable: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(node -p 42)"] })).toBe("allow");
	},
);
it("does not erase exec hazards when assignment prevents inner allow matching", () => {
	expect(
		evaluate("OCTOCODE_UNKNOWN=value find . -delete", {
			allow: ["Bash(OCTOCODE_UNKNOWN=*)"],
		}),
	).toBe("none");
});
it("does not silently stop before a deeply nested wrapper target", () => {
	expect(
		evaluate("nice ".repeat(40) + "printf BLOCK", {
			deny: ["Bash(printf BLOCK*)"],
		}),
	).toBe("unsupported");
});
it.each(["node -p 41 | cat", "(node -p 42)"])(
	"does not use an exact whole-composite allowance outside observed list semantics: %s",
	(command) => {
		expect(evaluate(command, { allow: [`Bash(${command})`] })).toBe("none");
	},
);
it("recognizes time -p for restrictions but not inner grants", () => {
	expect(evaluate("time -p printf BLOCK", { deny: ["Bash(printf BLOCK)"] })).toBe("deny");
	expect(evaluate("time -p printf BLOCK", { ask: ["Bash(printf BLOCK)"] })).toBe("ask");
	expect(evaluate("time -p printf BLOCK", { allow: ["Bash(printf BLOCK)"] })).toBe("none");
});
it.each(["'node' -p 42", "n\\ode -p 42", "'nice' node -p 42", 'n"od"e -p 42'])(
	"normalizes static executable spelling only: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(node -p 42)"] })).toBe("allow");
	},
);
it.each(["node -p '42'", "nice node -p '42'", "nice node -p 4\\2", '"n\\ode" -p 42'])(
	"does not normalize argument spelling or invalid double-quote escapes: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(node -p 42)"] })).toBe("none");
	},
);
it.each(['nice "find" . -delete', "find . '-delete'"])(
	"retains prefix hazards across literal quoting: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(*)"], deny: ["Bash(printf BLOCK)"] })).toBe("allow");
		expect(evaluate(command, { allow: ["Bash(nice *)", "Bash(find *)"] })).toBe("none");
	},
);
it.each([
	[" find . -delete", "Bash( find *)"],
	[" watch printf SAFE", "Bash( watch *)"],
])("preserves hazard inspection with leading whitespace: %s", (command, rule) => {
	expect(evaluate(command, { allow: [rule] })).not.toBe("allow");
});
it.each([
	['nice "-n" 4 find . -delete', "Bash(nice *)"],
	['command "-p" find . -delete', "Bash(command *)"],
	['timeout "-s" TERM 1s find . -delete', "Bash(timeout *)"],
])("does not hide hazards behind quoted wrapper options: %s", (command, rule) => {
	expect(evaluate(command, { allow: [rule] })).not.toBe("allow");
});
it("does not grant a padded exact find spelling through the whole-command fallback", () => {
	expect(evaluate(" find . -delete", { allow: ["Bash( find . -delete)"] })).toBe("none");
	expect(evaluate("find . -delete", { allow: ["Bash(find . -delete)"] })).toBe("allow");
});
