import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());
it("observes final failures without continuing, running Stop, or observing successful/aborted turns", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const capture = path.join(tmp(), "events.jsonl");
	const script = path.join(tmp(), "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n');console.error('do not continue');process.exitCode=2;});`,
	);
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				StopFailure: [{ matcher: "unknown", hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
				Stop: [{ hooks: [{ type: "command", command: 'echo \'{"decision":"block","reason":"normal stop"}\'' }] }],
			},
		}),
	);
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = {
		entries: [],
		context: {
			llmMessages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" }],
		},
	};
	const result = await fake.emit("agent_before_settle", { ...event, outcome: "error" }, ctx);
	expect(result.every((value) => value === undefined)).toBe(true);
	expect(JSON.parse(fs.readFileSync(capture, "utf8").trim())).toMatchObject({
		hook_event_name: "StopFailure",
		error: "unknown",
		error_details: "Provider unavailable",
		last_assistant_message: "Provider unavailable",
	});
	await fake.emit("agent_before_settle", { ...event, outcome: "completed" }, ctx);
	await fake.emit("agent_before_settle", { ...event, outcome: "aborted" }, ctx);
	expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1);
});
it.each(["octocode", "codex"] as const)("does not advertise StopFailure for %s", (protocol) => {
	const errors: string[] = [];
	parseHooks(
		{ hooks: { StopFailure: [{ hooks: [{ type: "command", command: "true" }] }] } },
		"fixture",
		undefined,
		errors,
		undefined,
		protocol,
	);
	expect(errors).toContainEqual(expect.stringContaining("unsupported"));
});
