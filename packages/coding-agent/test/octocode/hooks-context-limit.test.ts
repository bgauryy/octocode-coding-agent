import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { limitCodexContext } from "../../src/octocode/hooks/context-limit.ts";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import * as runner from "../../src/octocode/hooks/runner.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("uses Codex's UTF-8 byte estimate and default 2500-token spill threshold", () => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const text = "é".repeat(5000);
	expect(limitCodexContext(text)).toBe(text);
	const longer = `${text}!`;
	const preview = limitCodexContext(longer);
	expect(preview).toContain("original token count: 2501");
	expect(preview).not.toContain("\uFFFD");
	const file = preview.match(/Full hook output saved to: (.+)$/)?.[1];
	expect(file).toBeTruthy();
	expect(fs.readFileSync(file!, "utf8")).toBe(longer);
});
it("treats zero as no per-handler spill and retains small-limit Unicode boundaries", () => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const text = "🚀".repeat(3000);
	expect(limitCodexContext(text, 0)).toBe(text);
	expect(limitCodexContext(text, 1)).toContain("tokens truncated");
	expect(limitCodexContext(text, 1)).not.toContain("\uFFFD");
});
it("validates Codex limits and diagnoses limits on events that cannot emit context", () => {
	const parse = (limit: unknown, event = "PreToolUse") => {
		const errors: string[] = [];
		const config = parseHooks(
			{
				hooks: {
					[event]: [
						{
							hooks: [
								{
									type: "command",
									command: "echo hi",
									additionalContextLimit: limit,
								},
							],
						},
					],
				},
			},
			"fixture",
			undefined,
			errors,
			undefined,
			"codex",
		);
		return { config, errors };
	};
	for (const limit of [0, 42, 2500])
		expect(
			commandsFor(parse(limit).config, "PreToolUse", ["Bash"])[0],
		).toMatchObject({ additionalContextLimit: limit });
	for (const limit of [-1, 1.5, "42"]) {
		const parsed = parse(limit);
		expect(parsed.config.PreToolUse).toEqual([]);
		expect(parsed.errors.join()).toContain("additionalContextLimit");
	}
	const ignored = parse(42, "Stop");
	expect(ignored.errors.join()).toContain("ignoring additionalContextLimit");
	expect(ignored.config.Stop[0]?.hooks[0]).not.toHaveProperty(
		"additionalContextLimit",
	);
});
it.each([false, true])(
	"applies the per-handler context limit in actual dispatch (async=%s)",
	async (async) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(home, ".codex"));
		fs.writeFileSync(
			path.join(home, ".codex/hooks.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{
									type: "command",
									command: "fixture",
									async,
									additionalContextLimit: 256,
								},
							],
						},
					],
				},
			}),
		);
		const text = "start-" + "context ".repeat(750) + "-end";
		vi.spyOn(runner, "runHook").mockResolvedValue({
			code: 0,
			stderr: "",
			timedOut: false,
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					additionalContext: text,
				},
			}),
		});
		const f = fakePi();
		const ctx = fakeCtx({ cwd: tmp() });
		const hooks = registerHooks(
			f.pi,
			{ OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" },
			home,
		);
		await f.fire("session_start", { reason: "startup" }, ctx);
		try {
			await hooks.preToolUse(
				{
					toolName: "bash",
					toolCallId: "limited",
					input: { command: "true" },
				} as never,
				ctx,
			);
			await new Promise((resolve) => setImmediate(resolve));
			const result = async
				? await f.emit("before_agent_start", {}, ctx)
				: f.sent;
			expect(JSON.stringify(result)).toContain("Full hook output saved to:");
			expect(JSON.stringify(result)).not.toContain(text);
		} finally {
			await f.fire("session_shutdown", { reason: "quit" }, ctx);
		}
	},
);

it("treats null as the default and keeps different context limits distinct", () => {
	const errors: string[] = [];
	const config = parseHooks(
		{
			hooks: {
				PreToolUse: [
					{
						hooks: [null, 0, 42].map((additionalContextLimit) => ({
							type: "command",
							command: "same",
							additionalContextLimit,
						})),
					},
				],
			},
		},
		"fixture",
		undefined,
		errors,
		undefined,
		"codex",
	);
	expect(errors).toEqual([]);
	expect(commandsFor(config, "PreToolUse", ["Bash"])).toHaveLength(3);
});
