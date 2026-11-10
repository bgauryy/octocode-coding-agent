import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());

async function run(result: Record<string, unknown>) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	const capture = path.join(tmp(), "payload.json");
	const script = path.join(tmp(), "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'review the failure'}}));});`,
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const results = await fake.emit(
		"tool_result",
		{
			toolName: "bash",
			toolCallId: "codex-bash",
			input: { command: "npm test" },
			content: [{ type: "text", text: "1 test failed\n[exit 1]" }],
			isError: true,
			...result,
		},
		ctx,
	);
	return { capture, results };
}

it("runs Codex PostToolUse after a Bash command that exited non-zero", async () => {
	const { capture, results } = await run({ details: { exitCode: 1 } });
	expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command: "npm test" },
		tool_response: "1 test failed\n[exit 1]",
	});
	expect(JSON.stringify(results)).toContain("review the failure");
});

it.each([
	["aborted or timed-out call (no exit code)", { details: { termination: "timeout" } }],
	["terminated process (null exit code)", { details: { exitCode: null } }],
	["non-Bash tool error", { toolName: "read", details: { exitCode: 1 } }],
])("does not run Codex PostToolUse for a %s", async (_name, result) => {
	const { capture } = await run(result);
	expect(fs.existsSync(capture)).toBe(false);
});
