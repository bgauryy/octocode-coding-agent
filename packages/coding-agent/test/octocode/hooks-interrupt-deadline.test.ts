import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { INTERRUPT_HOOK_MS, registerInterruptHook } from "../../src/octocode/hooks/register/events.ts";
import type { HookClock } from "../../src/octocode/hooks/register/clock.ts";
import type { Dispatch, HookSession } from "../../src/octocode/hooks/register/types.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

it("bounds an Interrupt hook by the clock's deadline for INTERRUPT_HOOK_MS, without waiting for it", async () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({ hooks: { Interrupt: [{ hooks: [{ type: "command", command: "true" }] }] } }),
	);
	const loaded = loadHooks(tmp(), false, home, HOOK_SETTINGS);
	const session = { config: loaded.config, errors: [], root: undefined } as HookSession;

	const expiry = new AbortController();
	const asked: number[] = [];
	const clock: HookClock = {
		now: () => 0,
		deadline: (ms) => {
			asked.push(ms);
			return expiry.signal;
		},
	};
	const signals: Array<AbortSignal | undefined> = [];
	const dispatch = (async (_ctx, _event, _names, _input, signal) => {
		signals.push(signal);
		return {};
	}) as Dispatch;
	let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	const api = { bus: { on: (name: string, fn: typeof handler) => name === "agent_interrupted" && (handler = fn) } };
	registerInterruptHook(api as never, session, dispatch, () => ({ permissionMode: "manual" }), clock);

	await handler!({ model: {}, cwd: tmp(), turnId: "t", sessionId: "s" }, { hasUI: false });

	expect(asked).toEqual([INTERRUPT_HOOK_MS]);
	expect(signals).toEqual([expiry.signal]);
	expect(signals[0]?.aborted).toBe(false);
	expiry.abort();
	expect(signals[0]?.aborted).toBe(true);
});
