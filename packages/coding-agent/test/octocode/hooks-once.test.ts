import { expect, it } from "vitest";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";

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
