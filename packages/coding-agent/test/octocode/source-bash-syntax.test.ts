import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
beforeAll(initializeBashSyntax);
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
const source = {
	path: "/home/test/.claude/settings.json",
	anchor: "/home/test/.claude",
};
const decide = (command: string, permissions: Record<string, string[]>) =>
	evaluateSourcePolicy(
		parseSourcePolicy({ permissions }, source),
		{
			toolName: "bash",
			toolCallId: "syntax",
			input: { command },
			active: true,
		},
		"/work",
	);
const evaluate = (command: string, permissions: Record<string, string[]>) => decide(command, permissions).decision;
describe("source Bash syntax matching", () => {
	it.each([
		"printf '%s' 'SAFE; printf BLOCK'",
		"printf '%s' 'SAFE&&printf BLOCK'",
		"printf '%s' 'SAFE|printf BLOCK'",
		"printf BL\\OCK",
	])("does not reinterpret quoted or escaped source: %s", (command) => {
		expect(evaluate(command, { deny: ["Bash(printf BLOCK*)"] })).toBe("none");
	});
	it.each([
		"printf SAFE; printf BLOCK",
		"printf SAFE && printf BLOCK",
		"printf SAFE | printf BLOCK",
		"(printf BLOCK)",
		"printf '%s' \"$(printf BLOCK)\"",
		"printf BLOCK > output",
	])("finds executable raw command: %s", (command) => {
		expect(evaluate(command, { deny: ["Bash(printf BLOCK*)"] })).toBe("deny");
	});
	it("requires an allow for every executable segment", () => {
		expect(evaluate("printf SAFE && printf OTHER", { allow: ["Bash(printf SAFE)"] })).toBe("none");
		expect(
			evaluate("printf SAFE && printf OTHER", {
				allow: ["Bash(printf SAFE)", "Bash(printf OTHER)"],
			}),
		).toBe("allow");
	});
	it("does not approve recovered malformed syntax", () => {
		expect(
			evaluate("printf SAFE &&", {
				allow: ["Bash(printf *)"],
				deny: ["Bash(printf BLOCK*)"],
			}),
		).toBe("unsupported");
	});
});
it.each([
	"printf '😀'; printf '%s' \"$(printf BLOCK)\"",
	"printf '%s' `printf BLOCK`",
	"printf '%s' <(printf BLOCK)",
	"printf SAFE || printf BLOCK",
	"printf SAFE\nprintf BLOCK",
	"printf SAFE & printf BLOCK",
	"printf SAFE |& printf BLOCK",
	"if true; then printf BLOCK; fi",
	"f(){ printf BLOCK; }; f",
	"cat <<EOF\n$(printf BLOCK)\nEOF",
])("retains executable descendants, even in an unsupported enclosing construct: %s", (command) => {
	expect(evaluate(command, { deny: ["Bash(printf BLOCK*)"] })).toBe("deny");
});
it("does not turn a file redirection into a complete shell allow", () => {
	expect(evaluate("printf SAFE > output", { allow: ["Bash(printf *)"] })).toBe("none");
	expect(evaluate("printf SAFE > /dev/null", { allow: ["Bash(printf *)"] })).toBe("allow");
	expect(evaluate("printf SAFE 2>&1", { allow: ["Bash(printf *)"] })).toBe("allow");
});
it.each(['printf "$(other)"', "printf SAFE | other", "printf SAFE >$(other)"])(
	"does not grant an unmatched nested command: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(printf *)"] })).not.toBe("allow");
	},
);
// An allow rule only grants: syntax it cannot model leaves the call to the native mode, never a partial approval.
it.each([
	"if true; then printf SAFE; fi",
	"for f in a b; do printf SAFE; done",
	"cat <<'EOF'\nSAFE\nEOF",
	"export X=1 && printf SAFE",
])("leaves unmodelled syntax to the native mode under allow-only rules: %s", (command) => {
	expect(evaluate(command, { allow: ["Bash(printf *)", "Bash(cat *)", "Bash(export *)"] })).toBe("none");
});
it("refuses unmodelled syntax under a restriction, naming the construct and the rule", () => {
	const refused = decide("cat <<'EOF'\n$(printf BLOCK)\nEOF", { deny: ["Bash(printf BLOCK*)"] });
	expect(refused.decision).toBe("unsupported");
	expect(refused.message).toMatch(/heredoc/);
	expect(refused.message).toContain(`${source.path} (Bash)`);
	expect(evaluate("if true; then printf SAFE; fi", { allow: ["Bash(printf *)"], ask: ["Bash(rm *)"] })).toBe(
		"unsupported",
	);
});
it.each(["printf >target BLOCK", ">target printf BLOCK"])(
	"does not silently ignore words around a redirect: %s",
	(command) => {
		expect(evaluate(command, { deny: ["Bash(printf BLOCK*)"] })).toBe("none");
	},
);
it("accepts an exact whole command allowance as well as independent leaves", () => {
	expect(
		evaluate("node -p 41; node -p 42", {
			allow: ["Bash(node -p 41; node -p 42)"],
		}),
	).toBe("allow");
});
it.each(["printf > /dev/null BLOCK", "> /dev/null printf BLOCK"])(
	"does not invent an exact shorter allowance from redirect syntax: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(printf)"] })).toBe("none");
	},
);
it.each(["node -p 42 > marker", "if true; then node -p 42; fi"])(
	"preserves broad Bash allowance equivalence: %s",
	(command) => {
		expect(evaluate(command, { allow: ["Bash(*)"] })).toBe("allow");
		expect(evaluate(command, { allow: ["Bash"] })).toBe("allow");
	},
);
it("retains broad allowance after checking an unmatched scoped denial", () => {
	expect(
		evaluate("node -p 42 > marker", {
			allow: ["Bash(*)"],
			deny: ["Bash(printf BLOCK*)"],
		}),
	).toBe("allow");
});
it("treats colons inside raw shell arguments as command text", () => {
	expect(
		evaluate("printf http://blocked", {
			deny: ["Bash(printf http://blocked)"],
		}),
	).toBe("deny");
	expect(evaluate("printf value:blocked", { ask: ["Bash(printf value:blocked)"] })).toBe("ask");
});
