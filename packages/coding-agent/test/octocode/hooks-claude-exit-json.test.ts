import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

const DENY = JSON.stringify({
	hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no rm" },
});

/** Runs one Claude PreToolUse command hook through registration and returns the gate result and the audit spy. */
async function gate(script: string, extra: Record<string, unknown> = {}) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: process.execPath, args: ["-e", script], ...extra }],
					},
				],
			},
		}),
	);
	const { api, fire } = fakeHost(HOOK_SETTINGS);
	const audit = vi.fn();
	const hooks = registerHooks(api, {}, home, audit);
	const ctx = {
		cwd: tmp(),
		hasUI: false,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "exit-json", getSessionFile: () => undefined },
	};
	await fire("session_start", { reason: "startup" }, ctx);
	const result = await hooks.preToolUse(
		{ toolName: "bash", toolCallId: "exit-json-call", input: { command: "rm -rf build" } } as never,
		ctx as never,
	);
	return { result, audit };
}

describe("Claude hooks: valid JSON decides whatever the exit code (other than 2)", () => {
	it("applies a deny printed by a hook that exits 1, without auditing a fail-open failure", async () => {
		const { result, audit } = await gate(`process.stdout.write(${JSON.stringify(DENY)}); process.exit(1)`);
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("no rm") });
		expect(audit).not.toHaveBeenCalled();
	});

	it('still counts the run as a failure for onFailure: "block"', async () => {
		const { result, audit } = await gate(`process.stdout.write(${JSON.stringify(DENY)}); process.exit(1)`, {
			onFailure: "block",
		});
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("onFailure") });
		expect(audit).toHaveBeenCalledWith(expect.any(Array), expect.any(String), false);
	});

	it("keeps a hook that exits 1 with plain text a non-blocking failure", async () => {
		const { result, audit } = await gate(`process.stdout.write("deny"); process.exit(1)`);
		expect(result).toBeUndefined();
		expect(audit).toHaveBeenCalledWith(expect.any(Array), expect.any(String), true);
	});
});
