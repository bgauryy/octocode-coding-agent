import { expect, it } from "vitest";
import { interpret } from "../../src/octocode/hooks/runner.ts";
const run = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false });

it.each(["PreToolUse", "PostToolUse"] as const)("accepts neutral Codex universal defaults for %s", event => {
	expect(interpret(event, run({ continue: true, suppressOutput: false, stopReason: null }), "codex")).toEqual({});
});
it.each([
	{ extra: true }, { continue: null }, { reason: 42 }, { systemMessage: [] }, { decision: ["block"] },
	{ hookSpecificOutput: { hookEventName: ["PreToolUse"] } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ["deny"] } },
	{ hookSpecificOutput: [] }, { hookSpecificOutput: { additionalContext: "missing tag" } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: 42 } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
	{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: "orphan" } },
	{ reason: "orphan" }, { decision: "block", reason: " " },
])("rejects invalid Codex pre-tool output %j", value => {
	expect(interpret("PreToolUse", run(value), "codex")).toHaveProperty("error");
});
it("uses a Codex specific decision ahead of the legacy decision and reason", () => {
	expect(interpret("PreToolUse", run({ decision: "block", reason: "legacy", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "true" } } }), "codex")).toMatchObject({ updatedInput: { command: "true" } });
	expect(interpret("PreToolUse", run({ reason: "legacy", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "specific" } }), "codex")).toEqual({ block: "specific" });
});
it("treats nullable Codex updatedInput as absent", () => {
	expect(interpret("PreToolUse", run({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "specific", updatedInput: null } }), "codex")).toEqual({ block: "specific" });
});
it.each([{ decision: "block" }, { reason: "orphan" }, { hookSpecificOutput: { hookEventName: "PostToolUse", extra: true } }])("rejects invalid Codex post-tool output %j", value => {
	expect(interpret("PostToolUse", run(value), "codex")).toHaveProperty("error");
});

it.each(["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop"] as const)("rejects unknown Codex %s output fields without applying them", event => {
 expect(interpret(event, { code: 0, stdout: JSON.stringify({ continue: false, unexpected: true }), stderr: "", timedOut: false }, "codex")).toMatchObject({ error: expect.stringContaining("unknown") });
});
it.each(["PreCompact", "PostCompact", "Stop"] as const)("rejects hookSpecificOutput for Codex %s", event => {
 expect(interpret(event, { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: "invalid" } }), stderr: "", timedOut: false }, "codex")).toHaveProperty("error");
});
it.each(["Stop", "UserPromptSubmit"] as const)("rejects Codex %s block without a reason", event => {
 expect(interpret(event, { code: 0, stdout: '{"decision":"block"}', stderr: "", timedOut: false }, "codex")).toHaveProperty("error");
});
it("requires the Codex SessionStart context event tag and respects null context", () => {
 const run = (specific: unknown) => interpret("SessionStart", { code: 0, stdout: JSON.stringify({ hookSpecificOutput: specific }), stderr: "", timedOut: false }, "codex");
 expect(run({ additionalContext: "invalid" })).toHaveProperty("error");
 expect(run({ hookEventName: "SessionStart", additionalContext: null })).toEqual({});
});

it("treats a Codex pre-tool exit 2 without stderr as failure rather than denial", () => {
 const verdict = interpret("PreToolUse", { code: 2, stdout: "", stderr: " \n", timedOut: false }, "codex");
 expect(verdict).toHaveProperty("error");
 expect(verdict).not.toHaveProperty("block");
 expect(interpret("PreToolUse", { code: 2, stdout: "", stderr: " denied \n", timedOut: false }, "codex")).toEqual({ block: "denied" });
});
it.each(["not JSON", "[]", "null", "true"])("diagnoses invalid Codex pre-tool output %s", stdout => {
 expect(interpret("PreToolUse", { code: 0, stdout, stderr: "", timedOut: false }, "codex")).toHaveProperty("error");
});
it("trims Codex pre-tool decision reasons", () => {
 expect(interpret("PreToolUse", { code: 0, stdout: '{"decision":"block","reason":"  denied  "}', stderr: "", timedOut: false }, "codex")).toEqual({ block: "denied" });
});
