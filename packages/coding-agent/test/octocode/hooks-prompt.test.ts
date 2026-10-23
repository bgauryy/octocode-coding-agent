import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

async function fixture(protocol: "claude" | "codex", command: string, extra = {}) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const file = path.join(home, protocol === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			hooks: { UserPromptSubmit: [{ matcher: "[", hooks: [{ type: "command", command, ...extra }] }] },
		}),
	);
	const fake = fakePi();
	registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
	const ctx = fakeCtx({ cwd: tmp() });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { ...fake, ctx };
}

describe("source-profile user prompt hooks", () => {
	it.each(["claude", "codex"] as const)("%s rejects a prompt at its source-owned boundary", async (protocol) => {
		const f = await fixture(
			protocol,
			`echo '{"decision":"block","reason":"need a ticket","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"must not leak"}}'`,
		);
		if (protocol === "codex") {
			expect(await f.fire("input", { text: "edit files", source: "interactive" }, f.ctx)).toEqual({
				action: "continue",
			});
			expect(f.sent).toEqual([]);
			expect(await f.fire("user_input", { text: "edit files", source: "interactive" }, f.ctx)).toEqual({
				block: true,
				additionalContext: [expect.stringContaining("must not leak")],
			});
		} else {
			expect(await f.fire("input", { text: "edit files", source: "interactive" }, f.ctx)).toEqual({
				action: "handled",
			});
		}
		expect(f.sent).toEqual([]);
		expect(f.ctx.ui.notes).toContainEqual({ message: expect.stringContaining("need a ticket"), type: "warning" });
	});
	it.each(["claude", "codex"] as const)(
		"%s supplies prompt payload and delivers stdout without triggering a turn",
		async (protocol) => {
			const f = await fixture(
				protocol,
				`${process.execPath} -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.parse(s).prompt))'`,
			);
			expect(
				await f.fire("input", { text: "literal user prompt", source: "rpc", streamingBehavior: "steer" }, f.ctx),
			).toEqual({ action: "continue" });
			if (protocol === "codex") {
				expect(f.sent).toEqual([]);
				expect(
					await f.fire("user_input", { text: "literal user prompt", source: "rpc", streamingBehavior: "steer" }, f.ctx),
				).toEqual({ block: false, additionalContext: [expect.stringContaining("literal user prompt")] });
			} else {
				expect(f.sent).toEqual([
					{
						message: {
							customType: "octocode-hook-context",
							content: expect.stringContaining("literal user prompt"),
							display: false,
						},
						options: { triggerTurn: false },
					},
				]);
			}
		},
	);
	it("honors Claude failure blocking", async () => {
		const f = await fixture("claude", "exit 1", { onFailure: "block" });
		expect(await f.fire("input", { text: "prompt", source: "interactive" }, f.ctx)).toEqual({ action: "handled" });
	});
	it("preserves required prompt gates when their configuration is invalid", async () => {
		const f = await fixture("claude", "true", { onFailure: "block", args: "invalid" });
		expect(await f.fire("input", { text: "prompt", source: "interactive" }, f.ctx)).toEqual({ action: "handled" });
		expect(f.sent).toEqual([]);
	});
	it.each([
		["claude", 30_000],
		["codex", 600_000],
	] as const)("uses %s prompt timeout", (protocol, timeoutMs) => {
		const config = parseHooks(
			{ hooks: { UserPromptSubmit: [{ matcher: "[", hooks: [{ type: "command", command: "true" }] }] } },
			"fixture",
			undefined,
			[],
			undefined,
			protocol,
		);
		expect(commandsFor(config, "UserPromptSubmit", [])[0]?.timeoutMs).toBe(timeoutMs);
	});
	it("keeps prompt interception absent when compatibility is disabled", () => {
		const f = fakePi();
		registerHooks(f.pi, { OCTOCODE_HOOKS: "1" }, tmp());
		expect(f.handlers.has("input")).toBe(false);
	});

	it("does not introduce this event into the legacy profile", () => {
		const errors: string[] = [];
		const config = parseHooks(
			{ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] } },
			"fixture",
			undefined,
			errors,
		);
		expect(errors).toContainEqual(expect.stringContaining("unsupported"));
		expect(commandsFor(config, "UserPromptSubmit", [])).toEqual([]);
	});
});

it.each([{ command: "" }, { command: null }, { type: "prompt", prompt: "check input" }])(
	"does not silently remove a required malformed prompt gate: %j",
	async (invalid) => {
		const f = await fixture("claude", "true", { onFailure: "block", ...invalid });
		expect(await f.fire("input", { text: "prompt", source: "interactive" }, f.ctx)).toEqual({ action: "handled" });
		expect(f.sent).toEqual([]);
	},
);
