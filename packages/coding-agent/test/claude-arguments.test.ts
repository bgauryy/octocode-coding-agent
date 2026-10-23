import { expect, it } from "vitest";
import { expandClaudeArguments, expandClaudeVariables } from "../src/core/claude-arguments.ts";
import { parseCommandArgs } from "../src/core/prompt-templates.ts";

it.each([
	["$0 / $1 / $ARGUMENTS[0] / $ARGUMENTS", '"hello world"  second', [], 'hello world / second / hello world / "hello world"  second'],
	["$0", '"$1 $ARGUMENTS"', [], "$1 $ARGUMENTS"],
	["$2", "first", [], "$2\n\nARGUMENTS: first"],
	["$issue / $branch", "42", ["issue", "branch"], "42 / "],
	["No placeholder", "", [], "No placeholder"],
	["$UNDECLARED", "value", [], "$UNDECLARED\n\nARGUMENTS: value"],
	[String.raw`\$0 / \\$0 / \$OTHER`, "value", [], String.raw`$0 / \\value / \$OTHER`],
] as const)("expands Claude placeholders in %s without native one-based numbering", (body, raw, names, expected) => {
	expect(expandClaudeArguments(body, raw, parseCommandArgs(raw), names)).toBe(expected);
});

it("expands only available Claude variables after argument substitution", () => {
 const body = expandClaudeArguments("$0 | ${CLAUDE_SESSION_ID} | ${CLAUDE_PLUGIN_ROOT} | ${UNKNOWN}", "${CLAUDE_SKILL_DIR}", ["${CLAUDE_SKILL_DIR}"]);
 expect(expandClaudeVariables(body, { skillDir: "/skill", sessionId: "session" })).toBe("/skill | session | ${CLAUDE_PLUGIN_ROOT} | ${UNKNOWN}");
 expect(expandClaudeVariables("${CLAUDE_PLUGIN_ROOT}", { pluginRoot: "/literal/${CLAUDE_SESSION_ID}", sessionId: "session" })).toBe("/literal/${CLAUDE_SESSION_ID}");
});
