import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const handlers = [
	{ type: "command", command: "echo policy" },
	{ type: "http", url: "https://example.com/policy" },
	{ type: "mcp_tool", server: "policy", tool: "check" },
	{ type: "prompt", prompt: "Check the input" },
];

it.each(handlers)("ignores settings-level once for Claude $type hooks without removing the handler", (handler) => {
	const errors: string[] = [];
	const config = parseHooks(
		{ hooks: { PreToolUse: [{ hooks: [{ ...handler, once: true }] }] } },
		"settings.json",
		undefined,
		errors,
		undefined,
		"claude",
	);
	expect(errors).toEqual([]);
	for (let invocation = 0; invocation < 2; invocation++) {
		expect(commandsFor(config, "PreToolUse", ["Bash"])).toHaveLength(1);
	}
});

it("runs a Claude settings hook marked once on every matching call of the session", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	const marker = path.join(home, "runs");
	fs.writeFileSync(
		path.join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: `echo ran >> ${JSON.stringify(marker)}`, once: true }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const hooks = registerHooks(fake.api, { env: {}, home });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	for (const id of ["first", "second"])
		await hooks.preToolUse({ toolName: "bash", toolCallId: id, input: { command: "ls" } } as never, ctx);
	expect(fs.readFileSync(marker, "utf8")).toBe("ran\nran\n");
	await fake.fire("session_shutdown", { reason: "quit" }, ctx);
});

it.each(["codex", "octocode"] as const)("does not accept Claude once in the %s profile", (protocol) => {
	const errors: string[] = [];
	const config = parseHooks(
		{ hooks: { PreToolUse: [{ hooks: [{ ...handlers[0], once: true }] }] } },
		"hooks.json",
		undefined,
		errors,
		undefined,
		protocol,
	);
	expect(config.PreToolUse).toEqual([]);
	expect(errors.join()).toContain("once");
});

it("keeps a required malformed once handler as a blocking diagnostic", () => {
	const errors: string[] = [];
	const config = parseHooks(
		{ hooks: { PreToolUse: [{ hooks: [{ ...handlers[0], once: "yes", onFailure: "block" }] }] } },
		"settings.json",
		undefined,
		errors,
		undefined,
		"claude",
	);
	expect(commandsFor(config, "PreToolUse", ["Bash"])[0]).toMatchObject({
		failClosed: true,
		configurationError: expect.stringContaining("once"),
	});
});
