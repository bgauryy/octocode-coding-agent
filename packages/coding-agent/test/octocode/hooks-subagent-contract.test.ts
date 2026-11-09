import { expect, it } from "vitest";
import { profileSupport } from "../../src/octocode/hooks/catalog.ts";
import { hookPayload, matchesHook } from "../../src/octocode/hooks/profiles.ts";
import { interpret } from "../../src/octocode/hooks/runner.ts";
const run = (output: unknown, code = 0) => ({
	code,
	stdout: JSON.stringify(output),
	stderr: "reason",
	timedOut: false,
});
it("supports source subagent lifecycle events without changing native events", () => {
	for (const event of ["SubagentStart", "SubagentStop"]) {
		expect(profileSupport("codex", event)).toBeDefined();
		expect(profileSupport("claude", event)).toBeDefined();
		expect(profileSupport("octocode", event)).toBeUndefined();
		expect(matchesHook("codex", event, "^research$", ["general"])).toBe(false);
	}
});
it.each(["codex", "claude"] as const)("%s child start can only add context", (protocol) => {
	expect(
		interpret(
			"SubagentStart",
			run({
				continue: false,
				hookSpecificOutput: {
					hookEventName: "SubagentStart",
					additionalContext: "guide",
				},
			}),
			protocol,
		),
	).toEqual({ context: "guide" });
	expect(interpret("SubagentStart", run({}, 2), protocol)).toEqual({});
});
it("Codex child stop validates its own output schema and explicit termination", () => {
	expect(interpret("SubagentStop", run({ decision: "block" }), "codex").error).toContain("reason");
	expect(interpret("SubagentStop", run({ continue: false, decision: "block", reason: "retry" }), "codex")).toEqual({
		stop: true,
	});
	expect(interpret("SubagentStop", run({ decision: "block", reason: "retry" }), "codex")).toEqual({ block: "retry" });
});
it("projects live turn/model/permission metadata for Codex child lifecycle", () => {
	for (const event of ["SubagentStart", "SubagentStop"]) {
		expect(
			hookPayload("codex", { hook_event_name: event }, { model: "model", turnId: "turn", permissionMode: "full" }),
		).toMatchObject({
			model: "model",
			turn_id: "turn",
			permission_mode: "bypassPermissions",
		});
		expect(hookPayload("codex", { hook_event_name: event }, { permissionMode: "workspace" })).toHaveProperty(
			"permission_mode",
			"default",
		);
	}
});

it("hands down the actual parent transcript and clears inherited stale identity", async () => {
	const { subagentProcessEnv } = await import("../../src/octocode/subagents/process/env.ts");
	expect(subagentProcessEnv(undefined, { OCTOCODE_PARENT_TRANSCRIPT: "stale" }, { id: "child" })).not.toHaveProperty(
		"OCTOCODE_PARENT_TRANSCRIPT",
	);
	expect(subagentProcessEnv(undefined, {}, { id: "child", parentTranscript: "/actual/parent.jsonl" })).toHaveProperty(
		"OCTOCODE_PARENT_TRANSCRIPT",
		"/actual/parent.jsonl",
	);
});

it("does not add permission policy to Codex events whose source wire omits it", () => {
	for (const hook_event_name of ["SessionEnd", "PreCompact", "PostCompact"])
		expect(hookPayload("codex", { hook_event_name }, { permissionMode: "full" })).not.toHaveProperty("permission_mode");
});

it("keeps lifecycle handler eligibility and context limits source-specific", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { loadHooks } = await import("../../src/octocode/hooks/config.ts");
	const { commandsFor } = await import("../../src/octocode/hooks/config/calls.ts");
	const home = tmp();
	const cwd = tmp();
	const handlers = [
		{ type: "command", command: "true", additionalContextLimit: 7 },
		{ type: "http", url: "http://localhost:1234/hook" },
		{ type: "mcp_tool", server: "policy", tool: "review" },
		{ type: "prompt", prompt: "Check response" },
	];
	for (const protocol of ["claude", "codex"] as const) {
		fs.mkdirSync(path.join(home, `.${protocol}`));
		const hooks = Object.fromEntries(
			["SubagentStart", "SubagentStop"].map((event) => [
				event,
				[
					{
						matcher: "general",
						hooks: handlers.map((handler) =>
							protocol === "claude" && handler.type === "command" ? { type: "command", command: "true" } : handler,
						),
					},
				],
			]),
		);
		fs.writeFileSync(
			path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json"),
			JSON.stringify({ hooks }),
		);
	}
	const loaded = loadHooks(cwd, false, home);
	const types = (event: "SubagentStart" | "SubagentStop", protocol: string) =>
		commandsFor(loaded.config, event, ["general"])
			.filter((hook) => hook.protocol === protocol)
			.map((hook) => hook.type ?? "command");
	expect(types("SubagentStart", "claude")).toEqual(["command", "http", "mcp_tool"]);
	expect(types("SubagentStop", "claude")).toEqual(["command", "http", "mcp_tool", "prompt"]);
	expect(types("SubagentStart", "codex")).toEqual(["command", "mcp_tool"]);
	expect(types("SubagentStop", "codex")).toEqual(["command", "mcp_tool"]);
	expect(
		commandsFor(loaded.config, "SubagentStart", ["general"]).find(
			(hook) => hook.protocol === "codex" && "command" in hook && hook.command === "true",
		),
	).toHaveProperty("additionalContextLimit", 7);
	expect(
		commandsFor(loaded.config, "SubagentStop", ["general"]).find(
			(hook) => hook.protocol === "codex" && "command" in hook && hook.command === "true",
		),
	).not.toHaveProperty("additionalContextLimit");
});
