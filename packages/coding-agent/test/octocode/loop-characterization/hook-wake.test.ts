import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackgroundHooks } from "../../../src/octocode/hooks/background.ts";
import { runCommandHook } from "../../../src/octocode/hooks/command.ts";
import type { HookCommand } from "../../../src/octocode/hooks/contracts.ts";
import { count, sleep, type Rig, createRig } from "./rig.ts";

/**
 * The hook-process wake path (hooks/background.ts): an async-rewake command hook that exits 2 sends its stderr as feedback
 * through the gate, which starts a turn on an idle session (`hook.feedback`); other exits only queue context for the next
 * prompt or nothing (RFC agent-event-loop R0, §4). R8 changes the producer; what wakes and what stays silent must not move.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

async function hookRig() {
	let background: ReturnType<typeof registerBackgroundHooks> | undefined;
	const rig = await createRig({ register: (api) => void (background = registerBackgroundHooks(api)) });
	rigs.push(rig);
	if (!background) throw new Error("background hooks did not register");
	const warnings: string[] = [];
	const hook = (script: string, extra: Partial<HookCommand> = {}): HookCommand => ({
		type: "command",
		command: process.execPath,
		args: ["-e", script],
		timeoutMs: 10_000,
		source: "test",
		async: true,
		...extra,
	});
	const start = (command: HookCommand) =>
		background!.start(
			command,
			"Stop",
			(signal) => runCommandHook(command, {}, rig.ctx.cwd, process.env, signal),
			(message) => warnings.push(message),
		);
	return { rig, hook, start, warnings };
}

describe("a background hook process", () => {
	it("an async-rewake hook exiting 2 wakes the idle session with its stderr, in one turn", async () => {
		const { rig, hook, start } = await hookRig();
		rig.harness.setResponses([rig.reply("handled the feedback")]);
		start(hook("console.error('FIX-THE-LINT'); process.exit(2)", { asyncRewake: true }));
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "Background hook feedback:\nFIX-THE-LINT")).toBe(1);
	}, 20_000);

	it("exit 2 without asyncRewake, and a plain failure, wake nobody", async () => {
		const { rig, hook, start } = await hookRig();
		rig.harness.setResponses([rig.reply("should not run")]);
		start(hook("console.error('NOPE'); process.exit(2)"));
		start(hook("console.error('BOOM'); process.exit(1)", { asyncRewake: true }));
		await sleep(2000);
		expect(rig.requests).toHaveLength(0);
	}, 15_000);

	it("a hook exiting 0 with context holds it for the next prompt without a turn of its own", async () => {
		const { rig, hook, start } = await hookRig();
		rig.harness.setResponses([rig.reply("answered")]);
		start(hook("console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'LATE-CONTEXT'}}))"));
		await sleep(2000);
		expect(rig.requests).toHaveLength(0);
		await rig.harness.session.prompt("next question");
		await rig.harness.session.waitForIdle();
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], "LATE-CONTEXT")).toBe(1);
	}, 20_000);

	it("a shutdown aborts a running hook: its late exit 2 wakes nobody", async () => {
		const { rig, hook, start } = await hookRig();
		rig.harness.setResponses([rig.reply("should not run")]);
		start(hook("setTimeout(()=>{console.error('LATE');process.exit(2)},1500)", { asyncRewake: true }));
		await rig.harness.session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		await sleep(2500);
		expect(rig.requests).toHaveLength(0);
	}, 15_000);
});
