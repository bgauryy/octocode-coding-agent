import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandsFor, loadHooks } from "../../src/octocode/hooks/config.ts";
import { interpret } from "../../src/octocode/hooks/runner.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

function sources(matcher = "Bash", event = "PreToolUse", command = "echo same") {
	const home = tmp();
	const native = tmp();
	vi.stubEnv("OCTOCODE_HOME", native);
	for (const file of [path.join(home, ".claude/settings.json"), path.join(home, ".codex/hooks.json"), path.join(native, "hooks.json")]) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ hooks: { [event]: [{ matcher, hooks: [{ type: "command", command }] }] } }));
	}
	return { home, cwd: tmp() };
}

const run = (output: unknown) => ({ code: 0, stdout: JSON.stringify(output), stderr: "", timedOut: false });

describe("source hook profiles", () => {
	it("keeps three dialects separate while the legacy default still runs a duplicate once", () => {
		const { home, cwd } = sources();
		expect(commandsFor(loadHooks(cwd, false, home).config, "PreToolUse", ["Bash"])).toHaveLength(1);
		const selected = commandsFor(loadHooks(cwd, false, home, { sourceProfiles: true }).config, "PreToolUse", ["Bash"]);
		expect(selected.map((hook) => [hook.protocol ?? "octocode", hook.timeoutMs])).toEqual([
			["claude", 600_000], ["codex", 600_000], ["octocode", 60_000],
		]);
	});

	it.each([
		["Edit, Write", "Write", ["claude"]],
		["Edit.*", "NotebookEdit", ["claude", "codex"]],
		["Edit", "NotebookEdit", ["codex"]],
		["^Edit$", "NotebookEdit", []],
		["*", "Bash", ["claude", "codex", "octocode"]],
	] as const)("selects %s against %s by source semantics", (matcher, name, expected) => {
		const { home, cwd } = sources(matcher);
		const loaded = loadHooks(cwd, false, home, { sourceProfiles: true });
		expect(loaded.errors).toEqual([]);
		expect(commandsFor(loaded.config, "PreToolUse", [name]).map((hook) => hook.protocol ?? "octocode")).toEqual(expected);
	});

	it("ignores Stop matchers in upstream profiles, including invalid regexes", () => {
		const { home, cwd } = sources("(", "Stop");
		const loaded = loadHooks(cwd, false, home, { sourceProfiles: true });
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain("hooks.json");
		expect(commandsFor(loaded.config, "Stop", []).map((hook) => hook.protocol)).toEqual(["claude", "codex"]);
	});

	it.each([
		["Notification", ["claude", "octocode"], 1],
		["PreMessageSend", ["octocode"], 2],
		["PostMessageReceive", ["octocode"], 2],
	] as const)("does not present %s as a supported event of another host", (event, expected, diagnostics) => {
		const { home, cwd } = sources("*", event);
		const loaded = loadHooks(cwd, false, home, { sourceProfiles: true });
		expect(loaded.errors).toHaveLength(diagnostics);
		expect(commandsFor(loaded.config, event, []).map((hook) => hook.protocol ?? "octocode")).toEqual(expected);
	});

	it.each([{ field: "continue", value: false }, { field: "stopReason", value: "stop" }, { field: "suppressOutput", value: true }])("reports unsupported Codex PreToolUse field $field instead of treating it as a denial", ({ field, value }) => {
		const output = run({ [field]: value });
		expect(interpret("PreToolUse", output, "codex")).toEqual({ error: expect.stringContaining(field) });
	});

	it("keeps Claude ask and Codex unsupported ask distinct", () => {
		const output = run({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "confirm" } });
		expect(interpret("PreToolUse", output, "claude")).toEqual({ ask: "confirm" });
		expect(interpret("PreToolUse", output, "codex")).toEqual({ error: expect.stringContaining("ask") });
		expect(interpret("PreToolUse", output)).toEqual({ ask: "confirm" });
	});

	it("uses the selected profile in actual dispatch and audits a Codex unsupported result", async () => {
		const { home, cwd } = sources("Bash", "PreToolUse", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"confirm"}}'`);
		fs.rmSync(path.join(home, ".claude/settings.json"));
		fs.rmSync(path.join(process.env.OCTOCODE_HOME!, "hooks.json"));
		const { pi, fire } = fakePi();
		const audit = vi.fn();
		const hooks = registerHooks(pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home, audit);
		const ctx = { cwd, hasUI: false, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "profile-session", getSessionFile: () => undefined } };
		await fire("session_start", { reason: "startup" }, ctx);
		expect(await hooks.preToolUse({ toolName: "bash", toolCallId: "profile-call", input: { command: "true" } } as never, ctx as never)).toBeUndefined();
		expect(audit).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining("ask")]), expect.any(String), true);
		expect(hooks.report(cwd)).toContain("source codex; runtime codex");
	});
});

it("projects model and absent transcript metadata by source event without changing native input", async () => {
	const { hookPayload } = await import("../../src/octocode/hooks/profiles.ts");
	const payload = { hook_event_name: "PreToolUse", transcript_path: "", pi_tool_name: "bash", tool_input: { command: "true", timeout: 10 } };
	const metadata = { model: "fixture-model" };
	expect(hookPayload("codex", payload, metadata)).toEqual({ hook_event_name: "PreToolUse", transcript_path: null, model: "fixture-model", tool_input: { command: "true" } });
	expect(hookPayload("claude", payload, metadata)).not.toHaveProperty("model");
	expect(hookPayload("claude", { hook_event_name: "SessionStart" }, metadata)).toMatchObject({ model: "fixture-model" });
	expect(hookPayload("codex", { hook_event_name: "SessionEnd", transcript_path: "/session.jsonl" }, metadata)).toEqual({ hook_event_name: "SessionEnd", transcript_path: "/session.jsonl" });
	expect(hookPayload("octocode", payload, metadata)).toBe(payload);
});


it("projects owned logical turn identity only onto Codex turn-scoped events", async () => {
	const { hookPayload } = await import("../../src/octocode/hooks/profiles.ts");
	for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"]) {
		const input = { hook_event_name: event };
		expect(hookPayload("codex", input, { turnId: "turn-owned" })).toHaveProperty("turn_id", "turn-owned");
		expect(hookPayload("codex", input)).not.toHaveProperty("turn_id");
		expect(hookPayload("claude", input, { turnId: "turn-owned" })).not.toHaveProperty("turn_id");
		expect(hookPayload("octocode", input, { turnId: "turn-owned" })).toBe(input);
	}
	expect(hookPayload("codex", { hook_event_name: "SessionStart" }, { turnId: "turn-owned" })).not.toHaveProperty("turn_id");
});
