import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { interpret } from "../../src/octocode/hooks/runner.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

describe("compaction source semantics", () => {
	it("ignores Claude PreCompact continue but honors an explicit block", () => {
		expect(
			interpret("PreCompact", { code: 0, stdout: '{"continue":false}', stderr: "", timedOut: false }, "claude"),
		).toEqual({});
		expect(
			interpret("PreCompact", { code: 0, stdout: '{"decision":"block"}', stderr: "", timedOut: false }, "claude"),
		).toHaveProperty("block");
	});
	it.each(["claude", "codex"] as const)(
		"%s dispatches after compaction with dialect-specific control",
		async (protocol) => {
			const home = tmp();
			vi.stubEnv("OCTOCODE_HOME", tmp());
			const capture = path.join(tmp(), "payload.json");
			const script = path.join(tmp(), "hook.cjs");
			fs.writeFileSync(
				script,
				`let s=''; process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},s);console.log('{"continue":false}');});`,
			);
			const file = path.join(home, protocol === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({
					hooks: {
						PostCompact: [{ matcher: "auto", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }],
					},
				}),
			);
			const f = fakeHost(HOOK_SETTINGS);
			registerHooks(f.api, { env: {}, home });
			const ctx = fakeCtx({ cwd: tmp() });
			ctx.abort = vi.fn();
			await f.fire("session_start", { reason: "startup" }, ctx);
			await f.fire("session_compact", { reason: "manual", compactionEntry: { summary: "summary" } }, ctx);
			expect(fs.existsSync(capture)).toBe(false);
			await f.fire("session_compact", { reason: "overflow", compactionEntry: { summary: "summary" } }, ctx);
			expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
				hook_event_name: "PostCompact",
				trigger: "auto",
				compact_summary: "summary",
			});
			expect(ctx.abort).toHaveBeenCalledTimes(protocol === "codex" ? 1 : 0);
		},
	);
	it("keeps PostCompact unavailable to native configs", () => {
		const errors: string[] = [];
		const config = parseHooks(
			{ hooks: { PostCompact: [{ hooks: [{ type: "command", command: "true" }] }] } },
			"fixture",
			undefined,
			errors,
		);
		expect(errors).toContainEqual(expect.stringContaining("unsupported"));
		expect(commandsFor(config, "PostCompact", [])).toEqual([]);
	});
});
