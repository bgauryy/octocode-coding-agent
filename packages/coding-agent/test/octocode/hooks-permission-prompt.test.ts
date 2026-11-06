import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/**
 * A Claude PermissionRequest prompt hook whose evaluator (the model registry, the only external boundary here) answers
 * `answer`, asked through the hook view the permission gate calls before a dialog, relay or headless refusal.
 */
async function askWithPrompt(answer: string, hook: Record<string, unknown> = {}) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PermissionRequest: [
					{
						matcher: "Bash",
						hooks: [{ type: "prompt", prompt: "Judge $ARGUMENTS", model: "test/judge", ...hook }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp() });
	const model = { provider: "test", id: "judge" };
	const evaluations: string[] = [];
	Object.assign(ctx.modelRegistry, {
		getAll: () => [model],
		streamSimple: (_model: unknown, context: { messages: Array<{ content: string }> }) => {
			evaluations.push(context.messages[0].content);
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: answer }] }) };
		},
	});
	const hooks = registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const ask = () =>
		hooks.permissionRequest(
			captureToolInvocation("one", "bash", { command: "true" })!,
			ctx,
			new AbortController().signal,
		);
	return { ask, ctx, evaluations };
}

const warnings = (ctx: ReturnType<typeof fakeCtx>) =>
	ctx.ui.notes.filter((note) => note.type === "warning").map((note) => note.message);

it("denies on a malformed PermissionRequest prompt answer when the hook is failClosed, as the failure policy says", async () => {
	const { ask, ctx, evaluations } = await askWithPrompt('{"ok":"yes"}', { failClosed: true });
	const decision = await ask();
	expect(evaluations).toHaveLength(1);
	expect(decision).toMatchObject({ decision: "deny" });
	expect(warnings(ctx)).toContainEqual(expect.stringContaining("Prompt hook must return JSON with boolean ok"));
});

it("reports a malformed PermissionRequest prompt answer and leaves the approval open without failClosed", async () => {
	const { ask, ctx } = await askWithPrompt('{"ok":"yes"}');
	const decision = await ask();
	expect(decision?.decision).toBeUndefined();
	expect(warnings(ctx)).toContainEqual(expect.stringContaining("Prompt hook must return JSON with boolean ok"));
});

it("keeps a PermissionRequest prompt ok:false observational and shows its reason as a warning", async () => {
	const { ask, ctx } = await askWithPrompt(JSON.stringify({ ok: false, reason: "OBSERVED_RISK\u001b[31m" }), {
		failClosed: true,
	});
	const decision = await ask();
	// Observational: neither a deny (even failClosed: an answer is not a failure) nor an allow.
	expect(decision?.decision).toBeUndefined();
	const shown = warnings(ctx).filter((message) => message.includes("OBSERVED_RISK"));
	expect(shown).toEqual([expect.stringContaining("PermissionRequest prompt hook (observational)")]);
	expect(shown[0]).not.toContain("\u001b");
});

it("accepts a PermissionRequest prompt ok:true quietly", async () => {
	const { ask, ctx } = await askWithPrompt('{"ok":true}', { failClosed: true });
	expect((await ask())?.decision).toBeUndefined();
	expect(warnings(ctx)).toEqual([]);
});
