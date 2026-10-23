import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { interpret } from "../../src/octocode/hooks/runner.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

describe("source SessionEnd hooks", () => {
	it.each([
		["claude", "quit", false, "other"], ["claude", "new", false, "clear"], ["claude", "resume", false, "resume"],
		["claude", "reload", false, undefined], ["codex", "quit", false, "other"],
		["codex", "resume", false, undefined], ["codex", "quit", true, undefined],
	] as const)("%s on %s (subagent=%s) emits %s", async (protocol, reason, subagent, expected) => {
		const home = tmp();vi.stubEnv("OCTOCODE_HOME", tmp());
		const marker = path.join(tmp(), "payload.json");
		const script = path.join(tmp(), "capture.cjs");
		fs.writeFileSync(script, `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(marker)},s));`);
		const file = path.join(home, protocol === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ hooks: { SessionEnd: [{ matcher: expected ?? "", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] } }));
		const f = fakePi();const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		registerHooks(f.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1", OCTOCODE_SUBAGENT: subagent ? "1" : "0" }, home);
		await f.fire("session_start", { reason: "startup" }, ctx);
		await f.fire("session_shutdown", { reason }, ctx);
		if (expected) expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ hook_event_name: "SessionEnd", reason: expected });
		else expect(fs.existsSync(marker)).toBe(false);
	});
	it.each([["claude", undefined, 1500], ["codex", undefined, 1000], ["codex", 30, 3000]] as const)("uses %s end timeout %s -> %s", (protocol, timeout, expected) => {
		const config = parseHooks({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "true", timeout }] }] } }, "fixture", undefined, [], undefined, protocol);
		expect(commandsFor(config, "SessionEnd", ["other"])[0]?.timeoutMs).toBe(expected);
	});
	it.each(["claude", "codex"] as const)("discards %s SessionEnd decision output", (protocol) => {
		expect(interpret("SessionEnd", { code: 2, stdout: '{"continue":false}', stderr: "deny", timedOut: false }, protocol)).toEqual({});
	});
});
