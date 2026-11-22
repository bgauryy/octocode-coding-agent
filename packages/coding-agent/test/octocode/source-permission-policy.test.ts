import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
beforeAll(initializeBashSyntax);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateSourcePolicy, sourceToolDenied } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
const source = {
	path: "/home/test/.claude/settings.json",
	anchor: "/home/test/.claude",
};
const call = (toolName: string, input: unknown) => ({
	toolName,
	input,
	toolCallId: "one",
	active: true,
});
describe("Claude permission policy", () => {
	it("evaluates deny before ask before allow without granting by specificity", () => {
		const policy = parseSourcePolicy({ permissions: { allow: ["Bash"], ask: ["Bash"], deny: ["Bash"] } }, source);
		expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("deny");
		expect(sourceToolDenied(policy, "bash")).toBe(true);
	});
	it("keeps explicit ask distinct from no match and allow", () => {
		const policy = parseSourcePolicy({ permissions: { ask: ["Bash"] } }, source);
		expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("ask");
		expect(evaluateSourcePolicy(policy, call("read", { path: "a" }), "/work").decision).toBe("none");
	});
	it("denies a matching executable command inside substitution", () => {
		const policy = parseSourcePolicy({ permissions: { deny: ["Bash(rm *)"] } }, source);
		expect(evaluateSourcePolicy(policy, call("bash", { command: 'echo "$(rm a)"' }), "/work").decision).toBe("deny");
	});
	it("matches raw scalar parameters and does not invent omitted inputs", () => {
		const policy = parseSourcePolicy({ permissions: { ask: ["Agent(model:opus)"] } }, source);
		expect(evaluateSourcePolicy(policy, call("agent", { type: "task", model: "opus" }), "/work").decision).toBe("ask");
		expect(evaluateSourcePolicy(policy, call("agent", { type: "task" }), "/work").decision).toBe("none");
	});
	it("does not use path specifiers as tool-wide denial", () => {
		const policy = parseSourcePolicy({ permissions: { deny: ["Edit(secret/**)"] } }, source);
		expect(sourceToolDenied(policy, "file")).toBe(false);
		expect(
			evaluateSourcePolicy(
				policy,
				call("file", {
					queries: [{ type: "write", path: "secret/a", content: "x" }],
				}),
				"/work",
			).decision,
		).toBe("deny");
	});
});
it("keeps native operation envelopes in their actual source tool category", () => {
	const policy = parseSourcePolicy({ permissions: { deny: ["Bash", "WebFetch", "Agent", "Read"] } }, source);
	expect(
		evaluateSourcePolicy(policy, call("bash", { type: "powershell", command: "Write-Output ok" }), "/work").decision,
	).toBe("none");
	expect(evaluateSourcePolicy(policy, call("web", { query: "test" }), "/work").decision).toBe("none");
	expect(
		evaluateSourcePolicy(policy, call("agent", { type: "message", input: { id: "one", message: "hi" } }), "/work")
			.decision,
	).toBe("none");
	expect(
		evaluateSourcePolicy(policy, call("file", { queries: [{ type: "write", path: "a", content: "ok" }] }), "/work")
			.decision,
	).toBe("none");
});
it.each([
	["deny", "Read(.env)", "/work/nested/.env", "deny"],
	["deny", "Read(src/**)", "/work/vendor/src/a", "deny"],
	["allow", "Read(src/**)", "/work/vendor/src/a", "none"],
	["allow", "Read(src/**)", "/work/src/a", "allow"],
	["deny", "Read(/a)", "/home/test/.claude/a", "deny"],
	["deny", "Read(/a)", "/work/a", "none"],
	["deny", "Read(//private/a)", "/private/a", "deny"],
	["deny", "Write(secret/**)", "/work/secret/a", "none"],
] as const)("matches %s %s at %s", (behavior, rule, target, expected) => {
	const policy = parseSourcePolicy({ permissions: { [behavior]: [rule] } }, source);
	expect(
		evaluateSourcePolicy(policy, call(rule.startsWith("Write") ? "write" : "read", { path: target }), "/work").decision,
	).toBe(expected);
});
it("does not discard malformed restrictive settings", () => {
	for (const permissions of [null, { deny: "Bash" }, { ask: [false] }]) {
		const policy = parseSourcePolicy({ permissions }, source);
		expect(policy.errors.length).toBeGreaterThan(0);
		expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("unsupported");
	}
});
it("skips the source-defined ineffective settings forms", () => {
	const policy = parseSourcePolicy(
		{
			permissions: {
				deny: ["mcp__server__tool(arg:x)", "Bash(command:rm *)"],
				allow: ["*"],
			},
		},
		source,
	);
	expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("none");
	expect(evaluateSourcePolicy(policy, call("mcp__server__tool", { arg: "x" }), "/work").decision).toBe("none");
});
it("matches boolean parameters but never a missing value", () => {
	const policy = parseSourcePolicy({ permissions: { deny: ["Bash(run_in_background:true)"] } }, source);
	expect(
		evaluateSourcePolicy(policy, call("bash", { command: "true", run_in_background: true }), "/work").decision,
	).toBe("deny");
	expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("none");
});
it("refuses applicable ordered negation until its complete grouped semantics are supported", () => {
	const policy = parseSourcePolicy({ permissions: { deny: ["Read(!sample.env)"] } }, source);
	expect(evaluateSourcePolicy(policy, call("read", { path: "sample.env" }), "/work").decision).toBe("unsupported");
});
it("checks both canonical move targets", () => {
	const policy = parseSourcePolicy({ permissions: { deny: ["Edit(./protected.txt)"] } }, source);
	for (const [from, to] of [
		["protected.txt", "safe.txt"],
		["safe.txt", "protected.txt"],
	]) {
		expect(
			evaluateSourcePolicy(
				policy,
				call("file", {
					patch: `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-a\n+b\n*** End Patch`,
					reason: "test",
				}),
				"/work",
			).decision,
		).toBe("deny");
	}
});
it("bounds adversarial wildcard matching without regex backtracking", () => {
	const policy = parseSourcePolicy({ permissions: { deny: [`${"*a".repeat(25)}b`] } }, source);
	const start = performance.now();
	expect(evaluateSourcePolicy(policy, call("a".repeat(80), {}), "/work").decision).toBe("none");
	expect(performance.now() - start).toBeLessThan(100);
});
it("retains unrelated operations of combined native tools in the loadout", () => {
	const policy = parseSourcePolicy({ permissions: { deny: ["Agent", "WebFetch", "Write"] } }, source);
	expect(sourceToolDenied(policy, "agent")).toBe(false);
	expect(sourceToolDenied(policy, "web")).toBe(false);
	expect(sourceToolDenied(policy, "file")).toBe(false);
});
it("does not treat a non-projectable call as unmatched restrictive policy", async () => {
	const { unprojectedSourcePolicy } = await import("../../src/octocode/permission/source-policy.ts");
	const policy = parseSourcePolicy({ permissions: { deny: ["customFoo(flag:true)"] } }, source);
	expect(unprojectedSourcePolicy(policy, "customFoo").decision).toBe("unsupported");
	expect(unprojectedSourcePolicy(policy, "unrelated").decision).toBe("none");
});
it("reads supported source modes and directories, and diagnoses the rest without mapping native modes", () => {
	const policy = parseSourcePolicy(
		{
			permissions: {
				defaultMode: "acceptEdits",
				additionalDirectories: ["/tmp"],
				disableBypassPermissionsMode: "disable",
			},
		},
		source,
	);
	expect(policy.errors).toEqual([
		`${source.path}: permissions.disableBypassPermissionsMode is not supported by this policy adapter`,
	]);
	expect(policy.defaultMode).toBe("acceptEdits");
	expect(policy.additionalDirectories).toEqual(["/tmp"]);
	// acceptEdits allows file edits in the workspace; a shell command keeps no decision.
	expect(evaluateSourcePolicy(policy, call("bash", { command: "true" }), "/work").decision).toBe("none");
	for (const mode of ["bypassPermissions", "plan", "auto"]) {
		const unsupported = parseSourcePolicy({ permissions: { defaultMode: mode } }, source);
		expect(unsupported.errors).toEqual([`${source.path}: unsupported source permission mode ${mode}`]);
		expect(unsupported.defaultMode).toBeUndefined();
	}
});

it("checks requested and resolved paths for an existing alias and an absent child", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-paths-"));
	try {
		const cwd = path.join(root, "workspace"),
			outside = path.join(root, "outside");
		fs.mkdirSync(cwd);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "present"), "data");
		fs.symlinkSync(outside, path.join(cwd, "alias"));
		const allow = parseSourcePolicy({ permissions: { allow: ["Read(./alias/**)"] } }, source);
		const deny = parseSourcePolicy({ permissions: { deny: [`Read(/${outside}/**)`] } }, source);
		for (const leaf of ["present", "absent"]) {
			const input = { path: path.join(cwd, "alias", leaf) };
			expect(evaluateSourcePolicy(allow, call("read", input), cwd).decision).toBe("none");
			expect(evaluateSourcePolicy(deny, call("read", input), cwd).decision).toBe("deny");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
