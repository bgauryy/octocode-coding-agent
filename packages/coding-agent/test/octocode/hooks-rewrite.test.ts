import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
it.each(["claude", "codex"] as const)("validates %s rewritten arguments before changing the call", async protocol => {
	const home = tmp();vi.stubEnv("OCTOCODE_HOME", tmp());
	const file = path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json");fs.mkdirSync(path.dirname(file), { recursive: true });
	const fake = fakePi();
	fake.tools.set("bash", { name: "bash", description: "Run", parameters: Type.Object({ command: Type.String() }) });
	const hooks = registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	for (const command of ["rewritten", { invalid: true }]) {
		const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command } } };
		const script = path.join(tmp(), "rewrite.cjs");fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(output))});`);
		fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] } }));
		await fake.fire("session_start", { reason: "reload" }, ctx);
		const event = { toolName: "bash", toolCallId: "rewrite", input: { command: "original" } };
		const result = await hooks.preToolUse(event as never, ctx);
		if (typeof command === "string") { expect(event.input.command).toBe(command);expect(result).toMatchObject({ rewritten: true }); }
		else { expect(result).toMatchObject({ block: true });expect(event.input.command).toBe("original"); }
	}
});
it("applies Claude file rewrites through the registered native schema", async () => {
	const home = tmp();vi.stubEnv("OCTOCODE_HOME", tmp());fs.mkdirSync(path.join(home, ".claude"));
	const script = path.join(tmp(), "rewrite-file.cjs");
	fs.writeFileSync(script, 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{file_path:"/new.txt",content:"new"}}}));');
	fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] } }));
	const fake = fakePi();fake.tools.set("file", { name: "file", description: "Files", parameters: Type.Object({ queries: Type.Array(Type.Object({ type: Type.Literal("write"), path: Type.String(), content: Type.String(), reasoning: Type.String() })) }) });
	const hooks = registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = { toolName: "file", toolCallId: "rewrite-file", input: { queries: [{ type: "write", path: "old.txt", content: "old", reasoning: "create" }] } };
	expect(await hooks.preToolUse(event as never, ctx)).toMatchObject({ rewritten: true });
	expect(event.input.queries).toEqual([{ type: "write", path: "/new.txt", content: "new", reasoning: "create" }]);
});

it("projects Codex Bash command input and preserves native execution options on rewrite", async () => {
 const home = tmp();vi.stubEnv("OCTOCODE_HOME", tmp());fs.mkdirSync(path.join(home, ".codex"));
 const capture = path.join(home, "input.json");const script = path.join(home, "rewrite.cjs");
 fs.writeFileSync(script, `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'rewritten',timeout:999}}}));});`);
 fs.writeFileSync(path.join(home, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] } }));
 const fake = fakePi();fake.tools.set("bash", { name: "bash", description: "Run", parameters: Type.Object({ command: Type.String(), timeout: Type.Number(), background: Type.Boolean() }) });
 const hooks = registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
 const ctx = fakeCtx({ cwd: tmp(), hasUI: false });await fake.fire("session_start", { reason: "startup" }, ctx);
 const event = { toolName: "bash", toolCallId: "command-options", input: { command: "original", timeout: 10, background: true } };
 expect(await hooks.preToolUse(event as never, ctx)).toMatchObject({ rewritten: true });
 expect(JSON.parse(fs.readFileSync(capture, "utf8")).tool_input).toEqual({ command: "original" });
 expect(event.input).toEqual({ command: "rewritten", timeout: 10, background: true });
});
