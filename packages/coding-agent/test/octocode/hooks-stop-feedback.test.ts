import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
afterEach(() => vi.unstubAllEnvs());

it("continues Claude Stop feedback under the existing cap and lets termination win", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const file = path.join(home, ".claude/settings.json");
	fs.mkdirSync(path.dirname(file));
	const feedback = {
		type: "command",
		command: 'echo \'{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Run the checks"}}\'',
	};
	const write = (terminate = false) =>
		fs.writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					Stop: [
						{ hooks: [feedback, ...(terminate ? [{ type: "command", command: "echo '{\"continue\":false}'" }] : [])] },
					],
				},
			}),
		);
	write();
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, { env: {}, home });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = { outcome: "completed", entries: [], context: { llmMessages: [] } };
	for (let i = 0; i < 8; i++) {
		const results = await fake.emit("agent_before_settle", event, ctx);
		expect(results).toContainEqual(
			expect.objectContaining({
				continue: true,
				entries: [expect.objectContaining({ content: "Stop hook feedback:\nRun the checks" })],
			}),
		);
	}
	expect((await fake.emit("agent_before_settle", event, ctx)).every((value) => value === undefined)).toBe(true);
	write(true);
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "reload" }, ctx);
	await fake.fire("before_agent_start", {}, ctx);
	expect((await fake.emit("agent_before_settle", event, ctx)).every((value) => value === undefined)).toBe(true);
});

it("tells a Stop hook what still works after the turn, in Claude Code's background_tasks shape", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const capture = path.join(tmp(), "payloads.jsonl");
	const script = path.join(tmp(), "hook.cjs");
	fs.writeFileSync(
		script,
		`let s=''; process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(JSON.parse(s))+'\\n');});`,
	);
	const file = path.join(home, ".claude/settings.json");
	fs.mkdirSync(path.dirname(file));
	const stop = [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }];
	fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: stop } }));
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, { env: {}, home });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = { outcome: "completed", entries: [], context: { llmMessages: [] } };
	await fake.emit("agent_before_settle", event, ctx);
	const work = runningWorkOf(fake.api);
	work.set("bash", [{ kind: "bash", id: "bash-3", title: "tail the logs", detail: `tail -f ${"x".repeat(1200)}` }]);
	work.set("timer", [{ kind: "timer", id: "#4", title: "check the build", detail: "every 10m" }]);
	work.setBackground(["sly-mantle", "keen-otter"]);
	work.setQueued([{ id: "keen-otter", title: "queued · after B12 (sly-mantle)", held: false }]);
	await fake.emit("agent_before_settle", event, ctx);
	const [idle, busy] = fs
		.readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(idle.background_tasks).toEqual([]);
	expect(busy.background_tasks).toEqual([
		{ id: "sly-mantle", type: "subagent", status: "running", description: "sly-mantle" },
		{ id: "keen-otter", type: "subagent", status: "queued", description: "queued · after B12 (sly-mantle)" },
		{
			id: "bash-3",
			type: "shell",
			status: "running",
			description: "tail the logs",
			command: `tail -f ${"x".repeat(992)}… [+208 chars]`,
		},
		{ id: "#4", type: "timer", status: "scheduled", description: "check the build · every 10m" },
	]);
});
