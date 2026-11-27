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
	it.each(["claude", "codex"] as const)(
		"%s hooks also get the outcome: who asked, tokens before and after, the focus source and the lifted rules",
		async (protocol) => {
			const home = tmp();
			vi.stubEnv("OCTOCODE_HOME", tmp());
			const capture = path.join(tmp(), "payloads.jsonl");
			const script = path.join(tmp(), "hook.cjs");
			fs.writeFileSync(
				script,
				`let s=''; process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(JSON.parse(s))+'\\n');});`,
			);
			const file = path.join(home, protocol === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const hook = [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }];
			fs.writeFileSync(file, JSON.stringify({ hooks: { PreCompact: hook, PostCompact: hook } }));
			const f = fakeHost(HOOK_SETTINGS);
			registerHooks(f.api, { env: {}, home });
			const ctx = fakeCtx({ cwd: tmp() });
			await f.fire("session_start", { reason: "startup" }, ctx);
			await f.fire(
				"session_before_compact",
				{ reason: "manual", requestedBy: "agent", preparation: { tokensBefore: 212_000 } },
				ctx,
			);
			const lifted = [{ id: "C3", text: "Never push to main", reason: "the user allowed it" }];
			await f.fire(
				"session_compact",
				{
					reason: "manual",
					compactionEntry: {
						summary: "summary",
						tokensBefore: 212_000,
						details: { trigger: "agent", estimatedTokensAfter: 96_000, focus: { source: "agent" }, lifted },
					},
				},
				ctx,
			);
			// An entry written before outcomes were recorded still sends every field.
			await f.fire("session_compact", { reason: "threshold", compactionEntry: { summary: "older" } }, ctx);
			const [before, after, older] = fs
				.readFileSync(capture, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(before).toMatchObject({
				hook_event_name: "PreCompact",
				trigger: "manual",
				trigger_source: "agent",
				tokens_before: 212_000,
			});
			expect(after).toMatchObject({
				hook_event_name: "PostCompact",
				trigger: "manual",
				trigger_source: "agent",
				tokens_before: 212_000,
				tokens_after: 96_000,
				focus_source: "agent",
				lifted,
			});
			expect(older).toMatchObject({
				trigger: "auto",
				trigger_source: "threshold",
				tokens_before: null,
				tokens_after: null,
				focus_source: null,
				lifted: [],
			});
		},
	);
	it("passes a manual compaction's focus as custom_instructions, saying whose it is, and none for an automatic one", async () => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		const capture = path.join(tmp(), "payloads.jsonl");
		const script = path.join(tmp(), "hook.cjs");
		fs.writeFileSync(
			script,
			`let s=''; process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(JSON.parse(s))+'\\n');});`,
		);
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		const hook = [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }];
		fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: { PreCompact: hook } }));
		const f = fakeHost(HOOK_SETTINGS);
		registerHooks(f.api, { env: {}, home });
		const ctx = fakeCtx({ cwd: tmp() });
		await f.fire("session_start", { reason: "startup" }, ctx);
		const compact = (event: Record<string, unknown>) =>
			f.fire("session_before_compact", { preparation: { tokensBefore: 1000 }, ...event }, ctx);
		await compact({ reason: "manual", customInstructions: "Keep the test plan" });
		await compact({ reason: "manual", requestedBy: "agent", customInstructions: "Keep the open diff" });
		await compact({ reason: "manual" });
		await compact({ reason: "threshold", customInstructions: "ignored" });
		const [user, agent, bare, auto] = fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(user).toMatchObject({ custom_instructions: "Keep the test plan", custom_instructions_source: "user" });
		expect(agent).toMatchObject({ custom_instructions: "Keep the open diff", custom_instructions_source: "agent" });
		for (const payload of [bare, auto]) {
			expect(payload.custom_instructions).toBe("");
			expect(payload).not.toHaveProperty("custom_instructions_source");
		}
		expect(auto).toMatchObject({ trigger: "auto", trigger_source: "threshold" });
	});
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
