import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
it.each([
	{ output: { decision: "block", reason: "review this" }, nested: false, error: false },
	{ output: { decision: "block", reason: "review this" }, nested: true, error: false },
	{ output: { continue: false, stopReason: "review this" }, nested: true, error: false },
	{ output: { decision: "block", reason: "review this" }, nested: false, error: true },
])(
	"observes successful Codex results only (nested=$nested, error=$error, output=$output)",
	async ({ output, nested, error }) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(home, ".codex"));
		const capture = path.join(tmp(), "payload.json");
		const script = path.join(tmp(), "hook.cjs");
		fs.writeFileSync(
			script,
			`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},s);console.log(${JSON.stringify(JSON.stringify(output))});});`,
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
				toolCallId: "codex-call",
				...(nested ? { parentToolCallId: "parent" } : {}),
				input: { command: "false" },
				content: [{ type: "text", text: "original result" }],
				isError: error,
				details: { output: "original result" },
			},
			ctx,
		);
		if (error) {
			expect(fs.existsSync(capture)).toBe(false);
			expect(results.every((value) => value === undefined)).toBe(true);
			return;
		}
		expect(fs.existsSync(capture)).toBe(true);
		expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
			hook_event_name: "PostToolUse",
			tool_response: "original result",
		});
		const result = results.find((value) => value && typeof value === "object" && "content" in value) as {
			content: unknown;
			isError?: boolean;
			details?: unknown;
		};
		expect(JSON.stringify(result.content)).not.toContain("original result");
		expect(JSON.stringify(result.content)).toContain("review this");
		expect(result.details).toBeNull();
		if (nested && output.decision === "block") expect(result.isError).toBe(true);
		else expect(result.isError).toBeUndefined();
	},
);
