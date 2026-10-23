import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandsFor, parseHooks, type HookCommand } from "../../src/octocode/hooks/config.ts";
import { runHook } from "../../src/octocode/hooks/runner.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

function parse(handler: Record<string, unknown>, protocol: "claude" | "codex" | "octocode" = "claude") {
	const errors: string[] = [];
	const config = parseHooks({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, ...handler }] }] } }, "fixture", undefined, errors, undefined, protocol);
	return { hooks: commandsFor(config, "PreToolUse", ["Bash"]), errors };
}

describe("source command forms", () => {
	it("executes Claude argv without shell interpretation, preserving empty arguments and path placeholders", async () => {
		const cwd = tmp();
		const literal = "$(touch injected); `touch injected2` $HOME 'quoted'";
		const { hooks, errors } = parse({ args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "", literal, "${CLAUDE_PROJECT_DIR}/a b"] });
		expect(errors).toEqual([]);
		expect(hooks).toHaveLength(1);
		const result = await runHook(hooks[0]!, {}, cwd, { CLAUDE_PROJECT_DIR: cwd });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(["", literal, `${cwd}/a b`]);
		expect(fs.readdirSync(cwd)).toEqual([]);
	});

	it("keeps distinct argv invocations separate but deduplicates identical ones", () => {
		const config = parseHooks({ hooks: { PreToolUse: [{ hooks: ["one", "two", "one"].map((arg) => ({ type: "command", command: process.execPath, args: [arg] })) }] } }, "fixture", undefined, [], undefined, "claude");
		expect(commandsFor(config, "PreToolUse", ["Bash"]).map((hook) => "command" in hook ? hook.args : undefined)).toEqual([["one"], ["two"]]);
	});

	it.each(["wrong", [1], [null], null])("rejects malformed argv %j", (args) => {
		const result = parse({ args });
		expect(result.hooks).toEqual([]);
		expect(result.errors).toEqual([expect.stringContaining("args must be an array of strings")]);
	});

	it("keeps native and Codex argv unsupported", () => {
		for (const protocol of ["octocode", "codex"] as const) {
			const result = parse({ args: [] }, protocol);
			expect(result.hooks).toEqual([]);
			expect(result.errors[0]).toContain("args");
		}
	});

	it("turns synchronous spawn errors into failures instead of rejecting the dispatcher", async () => {
		const hook = { protocol: "claude", command: process.execPath, args: ["bad\0argument"], timeoutMs: 1000, source: "fixture" } as HookCommand;
		const result = await runHook(hook, {}, tmp());
		expect(result.code).toBeNull();
		expect(result.stderr).toMatch(/null|byte/i);
	});

	it("keeps a Codex Windows override without running it on POSIX", async () => {
		const { hooks, errors } = parse({ command: "echo posix", commandWindows: "echo windows" }, "codex");
		expect(errors).toEqual([]);
		expect(hooks[0]).toMatchObject({ commandWindows: "echo windows" });
		if (process.platform !== "win32") expect((await runHook(hooks[0]!, {}, tmp())).stdout.trim()).toBe("posix");
	});

	it.each(["block", "continue"])("applies Claude onFailure=%s to an actual failed pre-tool process", async (onFailure) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", "process.exit(1)"], onFailure }] }] } }));
		const { pi, fire } = fakePi();
		const audit = vi.fn();
		const hooks = registerHooks(pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home, audit);
		const ctx = { cwd: tmp(), hasUI: false, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "forms", getSessionFile: () => undefined } };
		await fire("session_start", { reason: "startup" }, ctx);
		const result = await hooks.preToolUse({ toolName: "bash", toolCallId: "forms-call", input: { command: "true" } } as never, ctx as never);
		if (onFailure === "block") expect(result).toMatchObject({ block: true, reason: expect.stringContaining("onFailure") });
		else expect(result).toBeUndefined();
		expect(audit).toHaveBeenCalledWith(expect.any(Array), expect.any(String), onFailure !== "block");
	});
	it.each([
		["claude", "exit 2", undefined, true],
		["codex", `echo '{"continue":false}'`, undefined, true],
		["claude", "exit 1", "block", true],
		["claude", "exit 1", "continue", false],
		["octocode", "exit 2", undefined, false],
	] as const)("routes %s PreCompact outcome from %s with onFailure=%s to the compaction owner", async (protocol, command, onFailure, cancel) => {
		const home = tmp();
		const native = tmp();
		vi.stubEnv("OCTOCODE_HOME", native);
		const file = protocol === "octocode" ? path.join(native, "hooks.json") : path.join(home, protocol === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command, ...(onFailure ? { onFailure } : {}) }] }] } }));
		const { pi, fire } = fakePi();
		registerHooks(pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
		const ctx = { cwd: tmp(), hasUI: false, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "compact", getSessionFile: () => undefined } };
		await fire("session_start", { reason: "startup" }, ctx);
		expect(await fire("session_before_compact", { reason: "manual", signal: new AbortController().signal }, ctx)).toEqual(cancel ? { cancel: true } : undefined);
	});

});
