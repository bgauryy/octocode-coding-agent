import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());

it.each(["guidance", "guidance".repeat(4000)])(
	"dedupes exact Claude child start contexts only while present in active projection (%#)",
	async (guidance) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(
			path.join(home, ".claude/settings.json"),
			JSON.stringify({
				hooks: {
					SubagentStart: [
						{
							matcher: "general",
							hooks: [
								{
									type: "command",
									command: `${process.execPath} -e 'console.log(${JSON.stringify(guidance)})'`,
								},
							],
						},
					],
				},
			}),
		);
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({
			cwd: tmp(),
			hasUI: false,
			model: { id: "fixture" },
		});
		let active: unknown[] = [];
		ctx.sessionManager.buildSessionProjection = () =>
			({
				entries: [],
				messages: active,
				model: null,
				thinkingLevel: "off",
			}) as never;
		registerHooks(
			fake.api,
			{
				OCTOCODE_SUBAGENT: "1",
				OCTOCODE_SUBAGENT_HOOKS: "1",
				OCTOCODE_PARENT_SESSION: "parent",
			},
			home,
			undefined,
			() => ({ permissionMode: "workspace" }),
		);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const start = async () =>
			(await fake.emit("before_agent_start", {}, ctx)).find(
				(value: any) => value?.message?.details?.subagentStartKeys,
			) as any;
		const initial = await start();
		expect(initial.message.content).toContain("guidance");
		active = [{ role: "custom", ...initial.message }];
		expect(await start()).toBeUndefined();
		active = [
			{
				role: "custom",
				...initial.message,
				details: { subagentStartKeys: [initial.message.content + " suffix"] },
			},
		];
		expect(await start()).toBeDefined();
		active = [];
		expect(await start()).toBeDefined();
	},
);

it("reports missing standalone child metadata without inventing permission or parent identity", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				SubagentStart: [{ hooks: [{ type: "command", command: "echo should-not-run" }] }],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		const hooks = registerHooks(
			fake.api,
			{
				OCTOCODE_SUBAGENT: "1",
				OCTOCODE_SUBAGENT_HOOKS: "1",
			},
			home,
		);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).not.toContain("should-not-run");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("live permission"));
		expect(hooks.report(ctx.cwd)).toContain("live permission");
	} finally {
		stderr.mockRestore();
	}
});

it("child source termination wins over native Stop continuation", async () => {
	const home = tmp();
	const native = tmp();
	vi.stubEnv("OCTOCODE_HOME", native);
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(native, "hooks.json"),
		JSON.stringify({
			hooks: {
				Stop: [
					{
						hooks: [
							{
								type: "command",
								command: `echo '{"decision":"block","reason":"native retry"}'`,
							},
						],
					},
				],
			},
		}),
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				SubagentStop: [
					{
						matcher: "general",
						hooks: [{ type: "command", command: `echo '{"continue":false}'` }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({
		cwd: tmp(),
		hasUI: false,
		model: { id: "fixture" },
	});
	ctx.getTurnId = () => "turn";
	registerHooks(fake.api, { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1" }, home, undefined, () => ({
		permissionMode: "full",
	}));
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const results = await fake.emit(
		"agent_before_settle",
		{ outcome: "completed", entries: [], context: { llmMessages: [] } },
		ctx,
	);
	expect(results.some((result: any) => result?.continue)).toBe(false);
});

it("reads the live permission owner for each shell hook dispatch", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	const capture = path.join(home, "payloads.jsonl");
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(capture)},s.trim()+'\\n'));`,
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				SubagentStop: [
					{
						hooks: [{ type: "command", command: `${process.execPath} ${script}` }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({
		cwd: tmp(),
		hasUI: false,
		model: { id: "fixture" },
	});
	ctx.getTurnId = () => "turn";
	let permissionMode: "workspace" | "full" = "workspace";
	registerHooks(fake.api, { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1" }, home, undefined, () => ({
		permissionMode,
	}));
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = {
		outcome: "completed",
		entries: [],
		context: { llmMessages: [] },
	};
	await fake.emit("agent_before_settle", event, ctx);
	permissionMode = "full";
	await fake.emit("agent_before_settle", event, ctx);
	expect(
		fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).permission_mode),
	).toEqual(["default", "bypassPermissions"]);
});
