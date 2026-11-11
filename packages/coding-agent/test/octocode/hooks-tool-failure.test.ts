import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

it.each([true, false])("dispatches Claude failure hooks only for failed results (error=%s)", async (isError) => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	const capture = path.join(tmp(), "failure.json");
	const script = path.join(tmp(), "failure.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUseFailure',additionalContext:'check the missing dependency'}}));});`,
	);
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PostToolUseFailure: [
					{ matcher: "Bash", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] },
				],
			},
		}),
	);
	const f = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(f.api, { env: {}, home });
	await f.fire("session_start", { reason: "startup" }, ctx);
	const content = [{ type: "text", text: "missing executable" }];
	const results = await f.emit(
		"tool_result",
		{ toolName: "bash", toolCallId: "failed-call", input: { command: "missing" }, content, isError },
		ctx,
	);
	if (isError) {
		expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
			hook_event_name: "PostToolUseFailure",
			tool_use_id: "failed-call",
			tool_name: "Bash",
			error: "missing executable",
		});
		expect(results).toContainEqual({
			content: [...content, { type: "text", text: expect.stringContaining("check the missing dependency") }],
		});
	} else expect(fs.existsSync(capture)).toBe(false);
});
